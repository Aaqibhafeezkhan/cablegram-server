import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildCoreApp,
  createCoreTestDb,
  ensureInitialSetupCode,
  issueSetupCode,
  loadOrCreateSecrets,
  migrateCore,
} from "../../packages/server-core/src/index.ts";

test("community db applies only core migrations and enforces downgrade protection", async () => {
  const db = await createCoreTestDb();
  try {
    const tables = (
      await db.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
      )
    ).rows.map((r) => r.tablename);

    // Only core tables exist in Community DB
    assert.deepEqual(tables, [
      "auth_rate_limits",
      "collection_members",
      "collections",
      "devices",
      "households",
      "media_items",
      "media_sources",
      "pairing_sessions",
      "phone_join_requests",
      "private_playback_grants",
      "profile_my_list",
      "profile_switch_requests",
      "profiles",
      "schema_migrations",
      "sessions",
      "setup_codes",
      "source_tombstones",
      "telegram_links",
      "telegram_phone_logins",
      "telegram_tv_logins",
      "telegram_tv_password_requests",
      "telegram_tv_sessions",
      "telegram_tv_state",
      "tv_commands",
      "users",
      "watch_progress",
    ]);

    // Simulate a database migrated by a newer binary version
    await db.query(
      `INSERT INTO schema_migrations (id, module, version) VALUES ('core:0099_future', 'core', 99)`,
    );
    await assert.rejects(() => migrateCore(db), /Downgrades are not supported/);
  } finally {
    await db.close();
  }
});

test("GET /api/server and GET /api/auth/methods advertise community capabilities and device sign-in", async () => {
  const db = await createCoreTestDb();
  const app = await buildCoreApp(db);
  try {
    const serverRes = await app.inject({ method: "GET", url: "/api/server" });
    assert.equal(serverRes.statusCode, 200);
    assert.deepEqual(serverRes.json(), {
      api_version: 1,
      edition: "community",
      server_version: "0.1.0",
      auth: { mode: "device" },
      features: {
        artwork: false,
        ai_title_resolution: false,
        subtitles: false,
        relay: false,
        web_import: false,
        cloud_storage: false,
        telegram: true,
        lan_playback: true,
        profile_lock: true,
      },
      legal: null,
    });

    const methodsRes = await app.inject({ method: "GET", url: "/api/auth/methods" });
    assert.equal(methodsRes.statusCode, 200);
    assert.deepEqual(methodsRes.json(), {
      mode: "device",
      google: null,
      apple: null,
      email_code: false,
    });
  } finally {
    await app.close();
    await db.close();
  }
});

test("device sign-in: setup code bootstrap, join request approval, denial, and plain library flow", async () => {
  const db = await createCoreTestDb();
  const app = await buildCoreApp(db);
  try {
    const initial = await ensureInitialSetupCode(db);
    assert.ok(initial, "Expected initial setup code on empty database");
    assert.match(initial.code, /^[0-9]{6}$/);

    // Wrong code is rejected
    const wrongClaim = await app.inject({
      method: "POST",
      url: "/api/auth/setup/claim",
      payload: { code: "000000", device_name: "Owner Phone" },
    });
    assert.equal(wrongClaim.statusCode, 400);
    assert.equal(wrongClaim.json().error, "invalid_setup_code");

    // Claim setup code with first phone
    const claimRes = await app.inject({
      method: "POST",
      url: "/api/auth/setup/claim",
      payload: { code: initial.code, device_name: "Owner Phone", household_name: "Home" },
    });
    assert.equal(claimRes.statusCode, 201, claimRes.body);
    const owner = claimRes.json() as {
      access_token: string;
      refresh_token: string;
      household_id: string;
      user_id: string;
      device_id: string;
    };
    assert.ok(owner.access_token);
    assert.ok(owner.refresh_token);
    const ownerAuth = { authorization: `Bearer ${owner.access_token}` };

    // Once a household exists, ensureInitialSetupCode returns null
    const secondCheck = await ensureInitialSetupCode(db);
    assert.equal(secondCheck, null);

    // Single-use: claiming again fails
    const replayClaim = await app.inject({
      method: "POST",
      url: "/api/auth/setup/claim",
      payload: { code: initial.code, device_name: "Another Phone" },
    });
    assert.equal(replayClaim.statusCode, 400);

    // Second phone starts a join request
    const joinStart = await app.inject({
      method: "POST",
      url: "/api/auth/join-requests",
      payload: { device_name: "Second Phone" },
    });
    assert.equal(joinStart.statusCode, 201);
    const joinReq = joinStart.json() as {
      id: string;
      poll_secret: string;
      short_code: string;
      expires_at: string;
    };
    assert.match(joinReq.short_code, /^[0-9]{6}$/);

    // Polling before approval returns pending
    const pollPending = await app.inject({
      method: "GET",
      url: `/api/auth/join-requests/${joinReq.id}`,
      headers: { authorization: `Join ${joinReq.poll_secret}` },
    });
    assert.equal(pollPending.statusCode, 200);
    assert.equal(pollPending.json().status, "pending");

    // Owner phone lists pending join requests
    const pendingList = await app.inject({
      method: "GET",
      url: "/api/auth/join-requests/pending",
      headers: ownerAuth,
    });
    assert.equal(pendingList.statusCode, 200);
    assert.equal(pendingList.json().requests.length, 1);
    assert.equal(pendingList.json().requests[0].id, joinReq.id);
    assert.equal(pendingList.json().requests[0].device_name, "Second Phone");

    // A secret in the query string is not accepted
    const pollQuery = await app.inject({
      method: "GET",
      url: `/api/auth/join-requests/${joinReq.id}?poll_secret=${joinReq.poll_secret}`,
    });
    assert.equal(pollQuery.statusCode, 401);

    // A wrong code is refused
    const wrongCode = await app.inject({
      method: "POST",
      url: `/api/auth/join-requests/${joinReq.id}/approve`,
      headers: ownerAuth,
      payload: { short_code: joinReq.short_code === "000000" ? "000001" : "000000" },
    });
    assert.equal(wrongCode.statusCode, 400);

    // Owner phone approves the join request
    const approveRes = await app.inject({
      method: "POST",
      url: `/api/auth/join-requests/${joinReq.id}/approve`,
      headers: ownerAuth,
      payload: { short_code: joinReq.short_code },
    });
    assert.equal(approveRes.statusCode, 200);
    assert.equal(approveRes.json().status, "approved");

    // Second phone polls and receives its session tokens
    const pollApproved = await app.inject({
      method: "GET",
      url: `/api/auth/join-requests/${joinReq.id}`,
      headers: { authorization: `Join ${joinReq.poll_secret}` },
    });
    assert.equal(pollApproved.statusCode, 200);
    const secondPhone = pollApproved.json();
    assert.equal(secondPhone.status, "approved");
    assert.equal(secondPhone.household_id, owner.household_id);
    assert.ok(secondPhone.access_token);

    // Polling again after token handoff does not return tokens a second time
    const pollReplay = await app.inject({
      method: "GET",
      url: `/api/auth/join-requests/${joinReq.id}`,
      headers: { authorization: `Join ${joinReq.poll_secret}` },
    });
    assert.equal(pollReplay.statusCode, 200);
    assert.equal(pollReplay.json().access_token, undefined);

    // Third phone join request denied
    const joinDenyStart = await app.inject({
      method: "POST",
      url: "/api/auth/join-requests",
      payload: { device_name: "Guest Phone" },
    });
    const denyReq = joinDenyStart.json() as { id: string; poll_secret: string };
    const denyRes = await app.inject({
      method: "POST",
      url: `/api/auth/join-requests/${denyReq.id}/deny`,
      headers: ownerAuth,
    });
    assert.equal(denyRes.statusCode, 200);
    const pollDenied = await app.inject({
      method: "GET",
      url: `/api/auth/join-requests/${denyReq.id}`,
      headers: { authorization: `Join ${denyReq.poll_secret}` },
    });
    assert.equal(pollDenied.json().status, "denied");

    // Recovery setup code adds a phone to the existing household
    const recovery = await issueSetupCode(db);
    const recoveryClaim = await app.inject({
      method: "POST",
      url: "/api/auth/setup/claim",
      payload: { code: recovery.code, device_name: "Recovery Phone" },
    });
    assert.equal(recoveryClaim.statusCode, 201);
    assert.equal(recoveryClaim.json().household_id, owner.household_id);

    // /api/me omits legal in Community
    const meRes = await app.inject({ method: "GET", url: "/api/me", headers: ownerAuth });
    assert.equal(meRes.statusCode, 200);
    assert.equal(meRes.json().legal, undefined);
    assert.equal(meRes.json().household.name, "Home");

    // Profiles have null avatar_url
    const profilesRes = await app.inject({ method: "GET", url: "/api/profiles", headers: ownerAuth });
    assert.equal(profilesRes.statusCode, 200);
    assert.equal(profilesRes.json().profiles[0].avatar_url, null);

    // Plain catalog item import, listing, and manual metadata edit
    const importRes = await app.inject({
      method: "POST",
      url: "/api/catalog/items",
      headers: ownerAuth,
      payload: {
        origin_filename: "The.Matrix.1999.mkv",
        origin_identity: "local:1",
        title: "The Matrix",
        duration_seconds: 8160,
      },
    });
    assert.equal(importRes.statusCode, 201);
    const itemId = importRes.json().id as string;

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/catalog/items/${itemId}`,
      headers: ownerAuth,
      payload: {
        title: "The Matrix (1999)",
        year: 1999,
        overview: "Sci-fi classic",
        expected_revision: 0,
        edit_id: randomUUID(),
      },
    });
    assert.equal(patchRes.statusCode, 200);
    assert.equal(patchRes.json().title, "The Matrix (1999)");

    const listRes = await app.inject({ method: "GET", url: "/api/catalog/items", headers: ownerAuth });
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.json().items.length, 1);
    assert.equal(listRes.json().items[0].title, "The Matrix (1999)");
    assert.equal(listRes.json().items[0].poster_url, null);
    assert.equal(listRes.json().items[0].backdrop_url, null);
  } finally {
    await app.close();
    await db.close();
  }
});

test("excluded endpoints return 410 feature_unavailable or 404 in Community", async () => {
  const db = await createCoreTestDb();
  const app = await buildCoreApp(db);
  try {
    const id = randomUUID();
    for (const [method, url] of [
      ["POST", "/api/library/resolve-title"],
      ["POST", "/api/library/enrich"],
      ["GET", "/api/catalog/sources/telegram/hints"],
      ["PUT", "/api/catalog/sources/telegram/hints"],
      ["GET", `/api/catalog/items/${id}/poster`],
      ["PUT", `/api/catalog/items/${id}/poster`],
      ["POST", "/api/library/web-imports"],
      ["GET", `/api/library/jobs/${id}`],
      ["POST", `/api/library/items/${id}/storage-transfers`],
      ["GET", "/api/storage/connections"],
      ["DELETE", `/api/storage/connections/${id}`],
    ] as const) {
      const res = await app.inject({ method, url });
      assert.equal(res.statusCode, 410, `Expected 410 for ${method} ${url}, got ${res.statusCode}`);
      assert.equal(res.json().error, "feature_unavailable");
    }

    for (const [method, url] of [
      ["GET", "/api/avatars/cat.png"],
      ["POST", "/internal/admin/plan"],
      ["GET", "/delete-account"],
    ] as const) {
      const res = await app.inject({ method, url });
      assert.equal(res.statusCode, 404, `Expected 404 for ${method} ${url}, got ${res.statusCode}`);
    }
  } finally {
    await app.close();
    await db.close();
  }
});

test("loadOrCreateSecrets auto-generates secrets.json with 0600 permissions and reuses it on restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "cablegram-secrets-"));
  try {
    const first = loadOrCreateSecrets(dir);
    assert.ok(first.jwtSecret.length >= 32);
    assert.ok(first.pinPepper.length >= 32);
    const mode = statSync(join(dir, "secrets.json")).mode & 0o777;
    assert.equal(mode, 0o600);

    const second = loadOrCreateSecrets(dir);
    assert.deepEqual(second, first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
