import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PGlite } from "@electric-sql/pglite";
import { z } from "zod";
import { hardwareHash, hashToken, pinLookup, randomPin, randomSecret, safeEqual } from "./secrets.ts";
import { issueSession, type Client } from "./sessions.ts";
import { clientIp, enforce, limitKey } from "./rate-limit.ts";
import { checkPinRate, clearPinFail, recordPinFail } from "../pairing/pin-rate-limit.ts";
import { requireAuth } from "../http/authorize.ts";
import { getHousehold, insertHousehold, insertUser, setHouseholdCreator } from "../households/repository.ts";

const SETUP_CODE_TTL_MS = 60 * 60 * 1000; // 1 hour
const JOIN_REQUEST_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_SETUP_ATTEMPTS = 5;
const HOUR = 3600;

/**
 * Issues a new single-use 6-digit setup code, expiring any previous unused codes.
 */
export async function issueSetupCode(db: PGlite, ttlMs = SETUP_CODE_TTL_MS): Promise<{ id: string; code: string; expires_at: string }> {
  const id = randomUUID();
  const code = randomPin();
  const expires_at = new Date(Date.now() + ttlMs).toISOString();
  await db.query(`UPDATE setup_codes SET expires_at = NOW() WHERE used_at IS NULL AND expires_at > NOW()`);
  await db.query(
    `INSERT INTO setup_codes (id, code_hash, expires_at) VALUES ($1, $2, $3)`,
    [id, hashToken(code), expires_at],
  );
  return { id, code, expires_at };
}

/**
 * On first start (when no household exists yet), issues a setup code and returns it so the server can print it.
 */
export async function ensureInitialSetupCode(db: PGlite): Promise<{ code: string; expires_at: string } | null> {
  const existingHousehold = await db.query(`SELECT 1 FROM households LIMIT 1`);
  if (existingHousehold.rows.length > 0) return null;
  const issued = await issueSetupCode(db);
  return { code: issued.code, expires_at: issued.expires_at };
}

async function ensureCommunityHouseholdAndUser(db: PGlite, householdName?: string) {
  const existing = await db.query<{ id: string; created_by_user_id: string | null; name: string }>(
    `SELECT id, created_by_user_id, name FROM households ORDER BY created_at LIMIT 1`,
  );
  if (existing.rows[0]) {
    const h = existing.rows[0];
    let userId = h.created_by_user_id;
    if (!userId) {
      const u = await db.query<{ id: string }>(`SELECT id FROM users WHERE household_id = $1 LIMIT 1`, [h.id]);
      if (u.rows[0]) {
        userId = u.rows[0].id;
      } else {
        userId = randomUUID();
        await insertUser(db, { id: userId, email: null, household_id: h.id });
        await setHouseholdCreator(db, h.id, userId);
      }
    }
    const p = await db.query<{ id: string }>(`SELECT id FROM profiles WHERE household_id = $1 ORDER BY sort_order LIMIT 1`, [h.id]);
    return { householdId: h.id, userId, profileId: p.rows[0]?.id ?? null, displayName: h.name };
  }

  const householdId = randomUUID();
  const userId = randomUUID();
  const profileId = randomUUID();
  const displayName = householdName?.trim() || "Home";
  await insertHousehold(db, { id: householdId, name: displayName });
  await insertUser(db, { id: userId, email: null, household_id: householdId });
  await setHouseholdCreator(db, householdId, userId);
  await db.query(
    `INSERT INTO profiles (id, household_id, name, sort_order) VALUES ($1, $2, $3, 0)`,
    [profileId, householdId, displayName],
  );
  return { householdId, userId, profileId, displayName };
}

export function registerDeviceSignInRoutes(app: FastifyInstance, db: PGlite) {
  app.get("/api/auth/methods", async () => ({
    mode: "device" as const,
    google: null,
    apple: null,
    email_code: false,
  }));

  app.post("/api/auth/setup/claim", async (req, reply) => {
    const body = z.object({
      code: z.string().trim().regex(/^\d{6}$/),
      device_name: z.string().trim().min(1).max(120).optional(),
      household_name: z.string().trim().min(1).max(80).optional(),
      hardware_id: z.string().max(128).optional(),
      client: z.enum(["app", "web"]).optional(),
    }).parse(req.body);

    const ip = clientIp(req);
    await enforce(db, [{ key: limitKey("setup-claim-ip", ip), limit: 20, windowSeconds: HOUR }]);
    checkPinRate(`setup:${ip}`, "too_many_setup_attempts");

    const active = await db.query<{ id: string; code_hash: string; expires_at: string; attempts: number }>(
      `SELECT id, code_hash, expires_at, attempts FROM setup_codes
       WHERE used_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    );
    const row = active.rows[0];
    if (!row) {
      recordPinFail(`setup:${ip}`);
      return reply.code(400).send({ error: "invalid_setup_code" });
    }
    if (new Date(row.expires_at) <= new Date() || row.attempts >= MAX_SETUP_ATTEMPTS) {
      recordPinFail(`setup:${ip}`);
      return reply.code(400).send({ error: "setup_code_expired" });
    }
    const expectedHash = hashToken(body.code);
    if (!safeEqual(row.code_hash, expectedHash)) {
      recordPinFail(`setup:${ip}`);
      await db.query(
        `UPDATE setup_codes SET attempts = attempts + 1,
           expires_at = CASE WHEN attempts + 1 >= $2 THEN NOW() ELSE expires_at END
         WHERE id = $1`,
        [row.id, MAX_SETUP_ATTEMPTS],
      );
      return reply.code(400).send({ error: "invalid_setup_code" });
    }

    const claimed = await db.query<{ id: string }>(
      `UPDATE setup_codes SET used_at = NOW() WHERE id = $1 AND used_at IS NULL AND expires_at > NOW() RETURNING id`,
      [row.id],
    );
    if (!claimed.rows[0]) {
      return reply.code(400).send({ error: "setup_code_expired" });
    }
    clearPinFail(`setup:${ip}`);

    const { householdId, userId, profileId, displayName } = await ensureCommunityHouseholdAndUser(db, body.household_name);
    const deviceId = randomUUID();
    const deviceSecret = randomSecret();
    await db.query(
      `INSERT INTO devices (id, household_id, kind, display_name, secret_hash, hardware_hash, user_id)
       VALUES ($1, $2, 'phone', $3, $4, $5, $6)`,
      [
        deviceId,
        householdId,
        body.device_name || "Phone",
        hashToken(deviceSecret),
        hardwareHash(body.hardware_id),
        userId,
      ],
    );

    const client: Client = body.client === "web" ? "web" : undefined;
    const tokens = await issueSession(db, userId, householdId, client, randomUUID(), deviceId);
    return reply.code(201).send({
      ...tokens,
      user_id: userId,
      household_id: householdId,
      profile_id: profileId,
      device_id: deviceId,
      device_secret: deviceSecret,
      display_name: displayName,
    });
  });

  app.post("/api/auth/join-requests", async (req, reply) => {
    const body = z.object({
      device_name: z.string().trim().min(1).max(120).optional(),
      client: z.enum(["app", "web"]).optional(),
    }).parse(req.body ?? {});

    const ip = clientIp(req);
    await enforce(db, [{ key: limitKey("join-request-ip", ip), limit: 30, windowSeconds: HOUR }]);

    const household = await db.query<{ id: string }>(`SELECT id FROM households ORDER BY created_at LIMIT 1`);
    if (!household.rows[0]) {
      return reply.code(409).send({ error: "server_not_initialized" });
    }

    const id = randomUUID();
    const shortCode = randomPin();
    const pollSecret = randomSecret();
    const expiresAt = new Date(Date.now() + JOIN_REQUEST_TTL_MS).toISOString();

    await db.query(
      `INSERT INTO phone_join_requests
         (id, household_id, short_code_lookup, poll_secret_hash, device_name, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
      [
        id,
        household.rows[0].id,
        pinLookup(shortCode),
        hashToken(pollSecret),
        body.device_name || "Phone",
        expiresAt,
      ],
    );

    return reply.code(201).send({
      id,
      short_code: shortCode,
      poll_secret: pollSecret,
      expires_at: expiresAt,
    });
  });

  app.get("/api/auth/join-requests/pending", async (req) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "phone") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    await db.query(
      `UPDATE phone_join_requests SET status = 'expired', resolved_at = NOW()
       WHERE household_id = $1 AND status = 'pending' AND expires_at <= NOW()`,
      [auth.household_id],
    );
    const r = await db.query<{ id: string; device_name: string; expires_at: string; created_at: string }>(
      `SELECT id, device_name, expires_at, created_at FROM phone_join_requests
       WHERE household_id = $1 AND status = 'pending' AND expires_at > NOW()
       ORDER BY created_at`,
      [auth.household_id],
    );
    return {
      requests: r.rows.map((row) => ({
        id: row.id,
        device_name: row.device_name,
        expires_at: row.expires_at,
        created_at: row.created_at,
      })),
    };
  });

  app.get("/api/auth/join-requests/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const authz = req.headers.authorization ?? "";
    const headerSecret = authz.startsWith("Join ") ? authz.slice(5).trim() : "";
    const querySecret = typeof (req.query as { poll_secret?: unknown })?.poll_secret === "string"
      ? String((req.query as { poll_secret: string }).poll_secret)
      : "";
    const pollSecret = headerSecret || querySecret;
    if (!pollSecret) throw Object.assign(new Error("unauthorized"), { statusCode: 401 });

    const r = await db.query<{
      id: string;
      household_id: string | null;
      poll_secret_hash: string;
      status: string;
      expires_at: string;
      device_id: string | null;
      access_token: string | null;
      refresh_token: string | null;
    }>(
      `SELECT id, household_id, poll_secret_hash, status, expires_at, device_id, access_token, refresh_token
       FROM phone_join_requests WHERE id = $1`,
      [id],
    );
    const row = r.rows[0];
    if (!row) throw Object.assign(new Error("not_found"), { statusCode: 404 });
    if (!safeEqual(row.poll_secret_hash, hashToken(pollSecret))) {
      throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
    }
    if (row.status === "pending" && new Date(row.expires_at) <= new Date()) {
      await db.query(`UPDATE phone_join_requests SET status = 'expired', resolved_at = NOW() WHERE id = $1`, [id]);
      return { id: row.id, status: "expired" as const };
    }
    if (row.status === "approved" && row.access_token && row.refresh_token && row.household_id) {
      await db.query(`UPDATE phone_join_requests SET access_token = NULL, refresh_token = NULL WHERE id = $1`, [id]);
      const household = await getHousehold(db, row.household_id);
      return {
        id: row.id,
        status: "approved" as const,
        access_token: row.access_token,
        refresh_token: row.refresh_token,
        household_id: row.household_id,
        device_id: row.device_id,
        display_name: household?.name ?? "Home",
      };
    }
    return { id: row.id, status: row.status };
  });

  async function resolveJoinRequest(
    requestId: string,
    householdId: string,
    approverUserId: string,
    outcome: "approved" | "denied",
    shortCode?: string,
  ) {
    if (shortCode) {
      checkPinRate(`join-approve:${householdId}`);
    }
    const r = await db.query<{ id: string; device_name: string; short_code_lookup: string; status: string; expires_at: string }>(
      `SELECT id, device_name, short_code_lookup, status, expires_at
       FROM phone_join_requests WHERE id = $1 AND household_id = $2`,
      [requestId, householdId],
    );
    const row = r.rows[0];
    if (!row) throw Object.assign(new Error("not_found"), { statusCode: 404 });
    if (row.status === "pending" && new Date(row.expires_at) <= new Date()) {
      await db.query(`UPDATE phone_join_requests SET status = 'expired', resolved_at = NOW() WHERE id = $1`, [requestId]);
      throw Object.assign(new Error("join_request_expired"), { statusCode: 409 });
    }
    if (row.status !== "pending") {
      throw Object.assign(new Error("join_request_not_pending"), { statusCode: 409 });
    }
    if (shortCode && !safeEqual(row.short_code_lookup, pinLookup(shortCode))) {
      recordPinFail(`join-approve:${householdId}`);
      throw Object.assign(new Error("invalid_short_code"), { statusCode: 400 });
    }
    if (shortCode) clearPinFail(`join-approve:${householdId}`);

    if (outcome === "denied") {
      await db.query(
        `UPDATE phone_join_requests SET status = 'denied', approved_by_user_id = $2, resolved_at = NOW()
         WHERE id = $1 AND status = 'pending'`,
        [requestId, approverUserId],
      );
      return { ok: true, status: "denied" as const };
    }

    const deviceId = randomUUID();
    const deviceSecret = randomSecret();
    await db.query(
      `INSERT INTO devices (id, household_id, kind, display_name, secret_hash, user_id)
       VALUES ($1, $2, 'phone', $3, $4, $5)`,
      [deviceId, householdId, row.device_name || "Phone", hashToken(deviceSecret), approverUserId],
    );
    const tokens = await issueSession(db, approverUserId, householdId, undefined, randomUUID(), deviceId);
    await db.query(
      `UPDATE phone_join_requests
       SET status = 'approved', approved_by_user_id = $2, device_id = $3,
           access_token = $4, refresh_token = $5, resolved_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
      [requestId, approverUserId, deviceId, tokens.access_token, tokens.refresh_token],
    );
    return { ok: true, status: "approved" as const, device_id: deviceId };
  }

  app.post("/api/auth/join-requests/:id/approve", async (req) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "phone") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ short_code: z.string().regex(/^\d{6}$/).optional() }).parse(req.body ?? {});
    return resolveJoinRequest(id, auth.household_id, auth.user_id, "approved", body.short_code);
  });

  app.post("/api/auth/join-requests/:id/deny", async (req) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "phone") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return resolveJoinRequest(id, auth.household_id, auth.user_id, "denied");
  });
}
