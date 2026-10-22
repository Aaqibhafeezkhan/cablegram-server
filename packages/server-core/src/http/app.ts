import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PGlite } from "@electric-sql/pglite";
import { coreConfig } from "../config.ts";
import type {
  AvatarRequestLike,
  CablegramPlugin,
  CoreHooks,
  PluginContext,
} from "../plugins.ts";
import { registerCommandRoutes, type TvPresence } from "./commands.ts";
import { registerTelegramRoutes } from "./telegram-routes.ts";
import { registerCors, parseWebOrigins } from "./cors.ts";
import { registerProfileLockRoutes } from "./profile-lock-routes.ts";
import { profileLanguages, registerLanguageRoutes } from "./language-routes.ts";
import { registerDeviceSignInRoutes } from "../auth/device-sign-in.ts";
import { refreshSession } from "../auth/sessions.ts";
import {
  hardwareHash,
  hashPassword,
  hashToken,
  verifyPassword,
  randomSecret,
} from "../auth/secrets.ts";
import { signTv } from "../auth/jwt.ts";
import { requireAuth, configureAuthDb, clearRevocation } from "./authorize.ts";
import { checkPinRate, recordPinFail, clearPinFail } from "../pairing/pin-rate-limit.ts";
import { assertNotVideoBody } from "./reject-video.ts";
import { getHousehold } from "../households/repository.ts";
import * as pairing from "../pairing/service.ts";
import * as catalog from "../catalog/service.ts";
import { patchMetadata } from "../catalog/metadata.ts";
import { upsertProgress } from "../progress/service.ts";
import {
  createPrivateApprovalRequest,
  grantStatus,
  approve as approveGrant,
  deny as denyGrant,
  consume as consumeGrant,
  startLanPlayback,
  verifyLanPass,
} from "../playback/private-grants.ts";
import { applyTrust, validateTrust, expireTemporaryDevices, trustFields } from "./trust.ts";
import {
  blocksImport,
  listTombstones,
  recordTombstoneResult,
  removeItem,
  restoreTombstone,
} from "../catalog/removal.ts";
import {
  createPurgeRegistry,
  schedulePurge,
} from "../maintenance/purge.ts";
import { registerServerRoutes } from "./server-routes.ts";

export interface BuildCoreAppOptions {
  plugins?: CablegramPlugin[];
  webOrigins?: string[];
  edition?: "community" | "hosted";
  serverVersion?: string;
}

export async function buildCoreApp(
  db: PGlite,
  options: BuildCoreAppOptions = {},
): Promise<FastifyInstance> {
  const plugins = options.plugins ?? [];
  let tvOnline: TvPresence = () => false;
  const app = Fastify({ logger: false });
  await app.register(websocket);
  registerCors(app, options.webOrigins ?? parseWebOrigins(process.env.WEB_APP_ORIGINS));
  const hooks: CoreHooks = {
    onActivity: [],
    onTvPlayback: [],
    afterTelegramItemImported: [],
    onCatalogItemWrite: [],
    onPhoneHardwareSeen: [],
    catalogDecorators: [],
    playbackResolvers: [],
    errorMappers: [],
  };

  configureAuthDb(db, async (dbConn, householdId, userId) => {
    for (const fn of hooks.onActivity) {
      await fn(dbConn, householdId, userId);
    }
  });

  const purgeSteps: Array<[table: string, sql: string]> = [];
  const purge = createPurgeRegistry(purgeSteps);

  function requestBase(req: AvatarRequestLike): string {
    if (coreConfig.publicBaseUrl) return coreConfig.publicBaseUrl.replace(/\/$/, "");
    const proto =
      String(req.headers["x-forwarded-proto"] ?? "").split(",")[0] ||
      (coreConfig.requireTls ? "https" : "http");
    return `${proto}://${String(req.headers.host ?? "localhost")}`;
  }

  const ctx: PluginContext = {
    app,
    db,
    auth: { require: requireAuth },
    hooks,
    purge,
    requestBase,
  };

  registerProfileLockRoutes(app, db);
  registerLanguageRoutes(app, db);

  for (const plugin of plugins) {
    await plugin.register(ctx);
  }

  if (!plugins.some((p) => p.name === "account-sign-in")) {
    registerDeviceSignInRoutes(app, db);
  }

  registerServerRoutes(app, {
    edition: options.edition,
    serverVersion: options.serverVersion,
    plugins,
    hooks,
  });

  for (const plugin of plugins) {
    if (plugin.start) {
      await plugin.start(ctx);
    }
  }

  const stopPurge = schedulePurge(db, undefined, purgeSteps);
  app.addHook("onClose", async () => {
    stopPurge();
    for (const plugin of plugins) {
      if (plugin.stop) await plugin.stop();
    }
  });

  async function resolveProfileAvatar(
    profileId: string,
    displayName: string,
    req?: AvatarRequestLike,
  ): Promise<string | null> {
    if (!hooks.profileAvatar) return null;
    return hooks.profileAvatar(db, profileId, displayName, req, req ? requestBase(req) : undefined);
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({
        error: "invalid_request",
        issues: err.issues.map(({ path, message }) => ({ path, message })),
      });
    }
    for (const mapper of hooks.errorMappers) {
      const mapped = mapper(err);
      if (mapped) {
        return reply.code(mapped.statusCode).send(mapped.body);
      }
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    const extra = (err as { extra?: Record<string, unknown> }).extra;
    reply
      .code(status)
      .send({ ...(extra ?? {}), error: err instanceof Error ? err.message : "internal_error" });
  });

  app.get("/health", async () => ({ ok: true }));

  app.post("/api/auth/refresh", async (req) => {
    const body = z.object({ refresh_token: z.string() }).parse(req.body);
    const refreshed = await refreshSession(db, body.refresh_token);
    if (!refreshed) throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
    for (const fn of hooks.onActivity) {
      await fn(db, refreshed.householdId, refreshed.userId);
    }
    return { access_token: refreshed.access_token, refresh_token: refreshed.refresh_token };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const body = z.object({ refresh_token: z.string() }).parse(req.body);
    await db.query(`UPDATE sessions SET revoked_at = NOW() WHERE refresh_token_hash = $1`, [
      hashToken(body.refresh_token),
    ]);
    return reply.code(204).send();
  });

  app.post("/api/auth/device", async (req, reply) => {
    const body = z
      .object({
        deviceName: z.string().max(200).optional(),
        hardwareId: z.string().max(128).optional(),
      })
      .passthrough()
      .safeParse(req.body ?? {});
    const session = await pairing.startPairing(
      db,
      body.success ? body.data.deviceName : undefined,
      hardwareHash(body.success ? body.data.hardwareId : undefined),
    );
    return reply.code(201).send({
      session_id: session.id,
      pin: session.pin,
      pairing_token: session.pairingToken,
      expires_at: session.expires_at,
    });
  });

  app.get("/api/auth/device/:sessionId", async (req) => {
    const { sessionId } = req.params as { sessionId: string };
    const authz = req.headers.authorization ?? "";
    const token = authz.startsWith("Pairing ") ? authz.slice(8) : "";
    const row = await pairing.pollPairing(db, sessionId, token);
    if ("status" in row && row.status === "expired") return { status: "expired" };
    if (row.status === "paired" && row.tv_device_id && row.household_id) {
      const access_token = await signTv(row.tv_device_id, row.household_id);
      return {
        status: "paired",
        access_token,
        device_id: row.tv_device_id,
        household_id: row.household_id,
        lan_capability: (row as { lan_capability?: string }).lan_capability,
      };
    }
    return { status: row.status };
  });

  app.post("/api/auth/device/claim", async (req) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "phone") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    const body = z
      .object({
        pin: z.string().regex(/^[0-9]{6}$/),
        tv_display_name: z.string().optional(),
        ...trustFields,
      })
      .parse(req.body);
    await validateTrust(db, auth.household_id, body);
    const { replacedDeviceIds, ...claimed } = await pairing.claimPin(
      db,
      auth.household_id,
      body.pin,
      body.tv_display_name ?? "TV",
    );
    for (const id of replacedDeviceIds) clearRevocation(id);
    try {
      await applyTrust(db, auth.household_id, claimed.device_id, body);
    } catch (error) {
      await db.query(`UPDATE devices SET revoked_at = NOW() WHERE id = $1`, [claimed.device_id]);
      throw error;
    }
    return claimed;
  });

  app.get("/api/me", async (req) => {
    const auth = await requireAuth(req);
    const household = await getHousehold(db, auth.household_id);
    await expireTemporaryDevices(db, auth.household_id);
    const devices = await db.query<{ id: string; kind: string }>(
      `SELECT id, kind, display_name, last_lan_host, last_lan_port, lan_cert_sha256, revoked_at, trust_level, trust_expires_at, telegram_direct_allowed FROM devices WHERE household_id = $1`,
      [auth.household_id],
    );
    const legal =
      auth.scope === "phone" && hooks.legalStatus
        ? await hooks.legalStatus(db, auth.user_id)
        : undefined;
    return {
      household,
      devices: devices.rows.map((d) => (d.kind === "tv" ? { ...d, online: tvOnline(d.id) } : d)),
      scope: auth.scope,
      profile_languages: await profileLanguages(db, auth.household_id),
      ...(legal ? { legal } : {}),
    };
  });

  app.post("/api/account/name", async (req) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "phone") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    const body = z
      .object({
        displayName: z.string().trim().min(1).max(80).optional(),
        name: z.string().trim().min(1).max(80).optional(),
      })
      .parse(req.body);
    const name = (body.displayName ?? body.name ?? "").trim();
    if (!name) throw Object.assign(new Error("name_required"), { statusCode: 400 });
    await db.query(`UPDATE households SET name = $1 WHERE id = $2`, [name, auth.household_id]);
    await db.query(
      `UPDATE profiles SET name = $1 WHERE household_id = $2 AND sort_order = 0`,
      [name, auth.household_id],
    );
    const household = await getHousehold(db, auth.household_id);
    return { ok: true, household, displayName: name };
  });

  app.patch("/api/household", async (req) => {
    const auth = await requireAuth(req);
    const body = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        profile_lock: z.boolean().optional(),
        shared_tv_idle_minutes: z
          .union([z.literal(30), z.literal(60), z.literal(240), z.literal(720)])
          .optional(),
      })
      .refine(
        (b) =>
          b.name !== undefined ||
          b.profile_lock !== undefined ||
          b.shared_tv_idle_minutes !== undefined,
      )
      .parse(req.body);
    if (body.profile_lock !== undefined || body.shared_tv_idle_minutes !== undefined) {
      if (auth.scope !== "phone") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    }
    if (body.profile_lock !== undefined) {
      await db.query(`UPDATE households SET profile_lock = $1 WHERE id = $2`, [
        body.profile_lock,
        auth.household_id,
      ]);
    }
    if (body.shared_tv_idle_minutes !== undefined) {
      await db.query(`UPDATE households SET shared_tv_idle_minutes = $1 WHERE id = $2`, [
        body.shared_tv_idle_minutes,
        auth.household_id,
      ]);
    }
    if (body.name !== undefined) {
      await db.query(`UPDATE households SET name = $1 WHERE id = $2`, [
        body.name,
        auth.household_id,
      ]);
      await db.query(
        `UPDATE profiles SET name = $1 WHERE household_id = $2 AND sort_order = 0`,
        [body.name, auth.household_id],
      );
    }
    return { household: await getHousehold(db, auth.household_id) };
  });

  app.get("/api/profiles", async (req) => {
    const auth = await requireAuth(req);
    await db.query(
      `UPDATE profiles p SET name = h.name
         FROM households h
        WHERE p.household_id = $1 AND p.household_id = h.id
          AND p.sort_order = 0 AND p.name = 'Default'`,
      [auth.household_id],
    );
    const r = await db.query<{
      id: string;
      name: string;
      sort_order: number;
      pin_set: boolean;
      ui_language: string;
      ui_language_override: string | null;
    }>(
      `SELECT p.id, p.name, p.sort_order, (p.pin_hash IS NOT NULL) AS pin_set,
         COALESCE(p.ui_language, u.ui_language, 'en') AS ui_language, p.ui_language AS ui_language_override
       FROM profiles p JOIN households h ON h.id = p.household_id
       LEFT JOIN users u ON u.id = h.created_by_user_id
       WHERE p.household_id = $1 ORDER BY p.sort_order`,
      [auth.household_id],
    );
    const profiles = [];
    for (const row of r.rows) {
      const avatarUrl = await resolveProfileAvatar(row.id, row.name, req);
      profiles.push({
        id: row.id,
        name: row.name,
        sort_order: row.sort_order,
        pin_set: row.pin_set,
        profile_type: "adult",
        profileType: "adult",
        avatar_url: avatarUrl,
        avatarUrl,
        ui_language: row.ui_language,
        ui_language_override: row.ui_language_override,
      });
    }
    return { profiles };
  });

  app.post("/api/profiles", async (req, reply) => {
    const auth = await requireAuth(req);
    const body = z
      .object({
        name: z.string().trim().min(1),
        pin: z.string().regex(/^[0-9]{4,8}$/).optional(),
        profileType: z.string().optional(),
        profile_type: z.string().optional(),
      })
      .parse(req.body);
    const id = randomUUID();
    const pin_hash = body.pin ? await hashPassword(body.pin) : null;
    await db.query(
      `INSERT INTO profiles (id, household_id, name, pin_hash, sort_order)
       VALUES ($1, $2, $3, $4,
         (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM profiles WHERE household_id = $2))`,
      [id, auth.household_id, body.name, pin_hash],
    );
    const avatarUrl = await resolveProfileAvatar(id, body.name, req);
    return reply.code(201).send({
      id,
      name: body.name,
      pin_set: Boolean(pin_hash),
      profile_type: body.profileType ?? body.profile_type ?? "adult",
      avatar_url: avatarUrl,
      avatarUrl,
    });
  });

  app.delete("/api/profiles/:profileId", async (req, reply) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "phone") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { profileId } = req.params as { profileId: string };
    const found = await db.query<{ sort_order: number }>(
      `SELECT sort_order FROM profiles WHERE id = $1 AND household_id = $2`,
      [profileId, auth.household_id],
    );
    const profile = found.rows[0];
    if (!profile) throw Object.assign(new Error("profile_not_found"), { statusCode: 404 });
    if (profile.sort_order === 0) throw Object.assign(new Error("owner_profile"), { statusCode: 409 });
    await db.transaction(async (tx) => {
      await tx.query(`DELETE FROM watch_progress WHERE profile_id = $1`, [profileId]);
      await tx.query(`DELETE FROM profile_switch_requests WHERE profile_id = $1`, [profileId]);
      await tx.query(`UPDATE private_playback_grants SET profile_id = NULL WHERE profile_id = $1`, [
        profileId,
      ]);
      await tx.query(`DELETE FROM profiles WHERE id = $1 AND household_id = $2`, [
        profileId,
        auth.household_id,
      ]);
    });
    return reply.code(204).send();
  });

  app.post("/api/profiles/:profileId/unlock", async (req) => {
    const auth = await requireAuth(req);
    const { profileId } = req.params as { profileId: string };
    const body = z.object({ pin: z.string().regex(/^[0-9]{4,8}$/) }).parse(req.body);
    const rateKey = `profile:${profileId}`;
    checkPinRate(rateKey);
    const row = await db.query<{ pin_hash: string | null; household_id: string }>(
      `SELECT pin_hash, household_id FROM profiles WHERE id = $1`,
      [profileId],
    );
    if (!row.rows[0] || row.rows[0].household_id !== auth.household_id) {
      throw Object.assign(new Error("profile_not_found"), { statusCode: 404 });
    }
    const ok =
      row.rows[0].pin_hash != null && (await verifyPassword(body.pin, row.rows[0].pin_hash));
    if (!ok) {
      recordPinFail(rateKey);
      throw Object.assign(new Error("invalid_pin"), { statusCode: 403 });
    }
    clearPinFail(rateKey);
    return { unlocked: true };
  });

  app.post("/api/playback/private-approvals", async (req, reply) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "tv") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    const body = z
      .object({
        media_item_id: z.string().uuid(),
        media_source_id: z.string().uuid().optional(),
        profile_id: z.string().uuid().optional(),
      })
      .parse(req.body);
    const item = await db.query<{ private: boolean }>(
      `SELECT COALESCE(BOOL_OR(s.private), FALSE) AS private
       FROM media_items i LEFT JOIN media_sources s ON s.media_item_id = i.id
       WHERE i.id = $1 AND i.household_id = $2`,
      [body.media_item_id, auth.household_id],
    );
    if (!item.rows[0]?.private) {
      throw Object.assign(new Error("not_private"), { statusCode: 400 });
    }
    const grant = await createPrivateApprovalRequest(
      db,
      auth.household_id,
      body.profile_id ?? null,
      auth.device_id,
      body.media_item_id,
      body.media_source_id ?? null,
    );
    return reply.code(201).send(grant);
  });

  app.get("/api/playback/private-approvals/pending", async (req) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "phone") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    const r = await db.query<{
      attempt_id: string;
      media_item_id: string | null;
      title: string | null;
      expires_at: string;
      tv_name: string | null;
    }>(
      `SELECT g.attempt_id, g.media_item_id, i.title, g.expires_at, d.display_name AS tv_name
       FROM private_playback_grants g
       LEFT JOIN media_items i ON i.id = g.media_item_id
       LEFT JOIN devices d ON d.id = g.tv_device_id
       WHERE g.household_id = $1 AND g.status = 'pending' AND g.expires_at > NOW()
       ORDER BY g.created_at`,
      [auth.household_id],
    );
    return {
      items: r.rows.map((row) => ({
        attempt_id: row.attempt_id,
        media_item_id: row.media_item_id,
        title: row.title,
        expires_at: row.expires_at,
        tv_name: row.tv_name,
      })),
    };
  });

  app.get("/api/playback/private-approvals/:attemptId", async (req) => {
    const auth = await requireAuth(req);
    const { attemptId } = req.params as { attemptId: string };
    const st = await grantStatus(db, auth.household_id, attemptId);
    if (!st) throw Object.assign(new Error("not_found"), { statusCode: 404 });
    return { attempt_id: attemptId, status: st.status, expires_at: st.expires_at };
  });

  app.post("/api/playback/private-approvals/:attemptId/approve", async (req) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "phone") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    return approveGrant(
      db,
      auth.household_id,
      auth.sub,
      (req.params as { attemptId: string }).attemptId,
    );
  });

  app.post("/api/playback/private-approvals/:attemptId/deny", async (req) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "phone") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    await denyGrant(db, auth.household_id, (req.params as { attemptId: string }).attemptId);
    return { ok: true };
  });

  app.post("/api/playback/private-approvals/:attemptId/redeem", async (req) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "tv") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    const body = z.object({ token: z.string().min(1) }).parse(req.body);
    const ok = await consumeGrant(
      db,
      (req.params as { attemptId: string }).attemptId,
      body.token,
    );
    if (!ok) throw Object.assign(new Error("invalid_grant"), { statusCode: 403 });
    return { ok: true };
  });

  app.post("/api/playback/private-approvals/:attemptId/cancel", async (req) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "tv") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    await db.query(
      `UPDATE private_playback_grants SET status = 'expired'
       WHERE attempt_id = $1 AND household_id = $2 AND tv_device_id = $3 AND status IN ('pending', 'approved')`,
      [(req.params as { attemptId: string }).attemptId, auth.household_id, auth.device_id],
    );
    return { ok: true };
  });

  app.post("/api/playback/private-approvals/:attemptId/start", async (req) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "tv") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    const started = await startLanPlayback(
      db,
      auth.household_id,
      auth.device_id,
      (req.params as { attemptId: string }).attemptId,
    );
    if (!started) throw Object.assign(new Error("invalid_grant"), { statusCode: 403 });
    return started;
  });

  app.post("/api/playback/lan-passes/verify", async (req) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "phone") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    const body = z.object({ pass: z.string().min(16).max(200) }).parse(req.body);
    const verified = await verifyLanPass(db, auth.household_id, body.pass);
    if (!verified) throw Object.assign(new Error("invalid_pass"), { statusCode: 404 });
    return verified;
  });

  app.post("/api/lan-capabilities/verify", async (req) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "phone") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    const body = z.object({ capability: z.string().min(16).max(200) }).parse(req.body);
    const tv = await db.query<{ id: string }>(
      `SELECT id FROM devices
       WHERE household_id = $1 AND kind = 'tv' AND revoked_at IS NULL AND secret_hash = $2`,
      [auth.household_id, hashToken(body.capability)],
    );
    if (!tv.rows[0]) throw Object.assign(new Error("unknown_capability"), { statusCode: 404 });
    return { tv_device_id: tv.rows[0].id };
  });

  app.put("/api/profiles/:profileId/my-list", async (req) => {
    const auth = await requireAuth(req);
    const { profileId } = req.params as { profileId: string };
    const body = z
      .object({
        item_ids: z.array(z.string().uuid()).min(1).max(500),
        present: z.boolean(),
      })
      .parse(req.body);
    const profile = await db.query(
      `SELECT 1 FROM profiles WHERE id = $1 AND household_id = $2`,
      [z.string().uuid().parse(profileId), auth.household_id],
    );
    if (!profile.rows[0]) throw Object.assign(new Error("profile_not_found"), { statusCode: 404 });
    if (body.present) {
      await db.query(
        `INSERT INTO profile_my_list (profile_id, media_item_id)
         SELECT $1, i.id FROM media_items i WHERE i.id = ANY($2::uuid[]) AND i.household_id = $3
         ON CONFLICT DO NOTHING`,
        [profileId, body.item_ids, auth.household_id],
      );
    } else {
      await db.query(
        `DELETE FROM profile_my_list WHERE profile_id = $1 AND media_item_id = ANY($2::uuid[])`,
        [profileId, body.item_ids],
      );
    }
    return { ok: true };
  });

  app.patch("/api/devices/:deviceId", async (req) => {
    const auth = await requireAuth(req);
    const { deviceId } = req.params as { deviceId: string };
    if (auth.scope === "tv" && auth.device_id !== deviceId) {
      throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    }
    const body = z
      .object({
        lan_host: z.string().optional(),
        lan_port: z.number().optional(),
        lan_cert_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        hardware_id: z.string().max(128).optional(),
        ...trustFields,
      })
      .parse(req.body);
    if (
      (body.trust_level !== undefined ||
        body.trust_expires_at !== undefined ||
        body.telegram_direct_allowed !== undefined ||
        body.lan_cert_sha256 !== undefined) &&
      auth.scope !== "phone"
    ) {
      throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    }
    const r = await db.query<{ household_id: string }>(
      `SELECT household_id FROM devices WHERE id = $1`,
      [deviceId],
    );
    if (!r.rows[0] || r.rows[0].household_id !== auth.household_id) {
      throw Object.assign(new Error("not_found"), { statusCode: 404 });
    }
    const hash = hardwareHash(body.hardware_id);
    if (hash) {
      await db.query(
        `UPDATE devices SET hardware_hash = COALESCE(hardware_hash, $1) WHERE id = $2`,
        [hash, deviceId],
      );
      if (auth.scope === "phone") {
        for (const fn of hooks.onPhoneHardwareSeen) {
          await fn(db, hash, auth.household_id);
        }
      }
    }
    await applyTrust(db, auth.household_id, deviceId, body);
    if (
      body.lan_host !== undefined ||
      body.lan_port !== undefined ||
      body.hardware_id !== undefined ||
      Object.keys(body).length === 0
    ) {
      await db.query(
        `UPDATE devices SET last_lan_host = $1, last_lan_port = $2, lan_cert_sha256 = $3 WHERE id = $4`,
        [body.lan_host ?? null, body.lan_port ?? null, body.lan_cert_sha256 ?? null, deviceId],
      );
    }
    return { ok: true };
  });

  app.delete("/api/devices/:deviceId", async (req, reply) => {
    const auth = await requireAuth(req);
    const params = req.params as { deviceId: string };
    const tvSelf =
      auth.scope === "tv" && (params.deviceId === "self" || params.deviceId === auth.device_id);
    if (auth.scope !== "phone" && !tvSelf)
      throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    const deviceId = tvSelf && auth.scope === "tv" ? auth.device_id : params.deviceId;
    await db.query(
      `UPDATE devices SET revoked_at = NOW() WHERE id = $1 AND household_id = $2`,
      [deviceId, auth.household_id],
    );
    clearRevocation(deviceId);
    return reply.code(204).send();
  });

  app.post("/api/devices/phone", async (req, reply) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "phone") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    const body = z
      .object({ hardware_id: z.string().max(128).optional() })
      .passthrough()
      .safeParse(req.body ?? {});
    const hash = hardwareHash(body.success ? body.data.hardware_id : undefined);
    const id = randomUUID();
    const secret = randomSecret();
    await db.query(
      `INSERT INTO devices (id, household_id, kind, display_name, secret_hash, hardware_hash, user_id) VALUES ($1, $2, 'phone', 'Phone', $3, $4, $5)`,
      [id, auth.household_id, hashToken(secret), hash, auth.user_id],
    );
    for (const fn of hooks.onPhoneHardwareSeen) {
      await fn(db, hash, auth.household_id);
    }
    return reply.code(201).send({ device_id: id, device_secret: secret });
  });

  async function catalogForRequest(req: Parameters<typeof requireAuth>[0]) {
    const auth = await requireAuth(req);
    const q = req.query as {
      profile_id?: string;
      search?: string;
      media_type?: string;
      shelf?: string;
      collection_id?: string;
    };
    const profileId =
      q.profile_id && /^[0-9a-f-]{36}$/i.test(q.profile_id) ? q.profile_id : undefined;
    const base = requestBase(req);
    const items = await catalog.listCatalog(db, auth.household_id, profileId, q);
    for (const decorator of hooks.catalogDecorators) {
      await decorator({
        db,
        householdId: auth.household_id,
        profileId,
        requestBase: base,
        items: items as unknown as Parameters<typeof decorator>[0]["items"],
      });
    }
    return { items };
  }

  async function catalogWithEtag(
    req: Parameters<typeof requireAuth>[0],
    reply: { header(k: string, v: string): unknown; code(n: number): { send(): unknown } },
  ) {
    const body = await catalogForRequest(req);
    const etag = `"${createHash("sha256").update(JSON.stringify(body)).digest("base64url")}"`;
    reply.header("etag", etag);
    reply.header("cache-control", "private, no-cache");
    const sent = String(req.headers["if-none-match"] ?? "")
      .split(",")
      .map((v) => v.trim().replace(/^W\//, ""));
    if (sent.includes(etag) || sent.includes("*")) return reply.code(304).send();
    return body;
  }

  app.get("/api/catalog/items", async (req, reply) => catalogWithEtag(req, reply));

  app.get("/api/library/items", async (req, reply) => catalogWithEtag(req, reply));

  app.get("/api/catalog/collections", async (req) => {
    const auth = await requireAuth(req);
    return { collections: await catalog.listCollections(db, auth.household_id) };
  });

  app.post("/api/catalog/collections", async (req, reply) => {
    const auth = await requireAuth(req);
    const body = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
    return reply.code(201).send(await catalog.createCollection(db, auth.household_id, body.name));
  });

  app.delete("/api/catalog/collections/:collectionId", async (req, reply) => {
    const auth = await requireAuth(req);
    const { collectionId } = req.params as { collectionId: string };
    await catalog.deleteCollection(db, auth.household_id, collectionId);
    return reply.code(204).send();
  });

  app.put("/api/catalog/items/:itemId/collections/:collectionId", async (req) => {
    const auth = await requireAuth(req);
    const { itemId, collectionId } = req.params as { itemId: string; collectionId: string };
    const body = z.object({ present: z.boolean().default(true) }).parse(req.body ?? {});
    return catalog.setCollectionMember(db, auth.household_id, collectionId, itemId, body.present);
  });

  app.post("/api/catalog/sources/reconcile", async (req) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "phone") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    const body = z
      .object({
        serving_device_id: z.string().uuid().optional(),
        present_sources: z.array(
          z.object({
            stable_source_key: z.string().optional(),
            phone_location: z.string().optional(),
            source_fingerprint: z.string().optional(),
          }),
        ),
      })
      .parse(req.body);
    if (body.serving_device_id) {
      const device = await db.query<{ id: string }>(
        `SELECT id FROM devices WHERE id = $1 AND household_id = $2 AND kind = 'phone' AND revoked_at IS NULL`,
        [body.serving_device_id, auth.household_id],
      );
      if (!device.rows[0])
        throw Object.assign(new Error("unknown_source_device"), { statusCode: 400 });
    }
    return catalog.reconcilePhoneSources(
      db,
      auth.household_id,
      body.present_sources,
      body.serving_device_id,
    );
  });

  app.post("/api/catalog/items", async (req, reply) => {
    assertNotVideoBody(req.headers as Record<string, unknown>, req.body);
    const auth = await requireAuth(req);
    const body = z
      .object({
        origin_filename: z.string(),
        origin_identity: z.string(),
        title: z.string().optional(),
        duration_seconds: z.number().transform(Math.round).optional(),
        serving_device_id: z.string().uuid().optional(),
        poster_url: z.string().optional(),
        media_type: z.enum(["movie", "tv"]).optional(),
        series_identity: z.string().optional(),
        season_number: z.number().int().positive().optional(),
        episode_number: z.number().int().positive().optional(),
        episode_title: z.string().optional(),
        genres: z.array(z.string()).optional(),
        match_status: z.string().optional(),
        stable_source_key: z.string().optional(),
        phone_location: z.string().optional(),
        source_fingerprint: z.string().optional(),
        private: z.boolean().optional(),
        source_kind: z.enum(["phone_local", "telegram"]).optional(),
        bytes_total: z.number().int().nonnegative().optional(),
        playback_mime: z.string().max(100).optional(),
        attach_to_item_id: z.string().uuid().optional(),
        attach_to_origin_identity: z.string().min(1).max(200).optional(),
      })
      .parse(req.body);
    if (
      (body.attach_to_item_id || body.attach_to_origin_identity) &&
      (body.source_kind !== "telegram" || auth.scope !== "phone")
    ) {
      throw Object.assign(
        new Error(auth.scope !== "phone" ? "forbidden" : "invalid_telegram_source"),
        { statusCode: auth.scope !== "phone" ? 403 : 400 },
      );
    }
    if (body.source_kind === "telegram") {
      const origin = /^tg:(-?\d{1,19}):(\d{1,19})$/.exec(body.origin_identity);
      if (
        !origin ||
        !/^tgfile:[A-Za-z0-9_-]{8,200}$/.test(body.stable_source_key ?? "") ||
        body.serving_device_id
      ) {
        throw Object.assign(new Error("invalid_telegram_source"), { statusCode: 400 });
      }
      const link = await db.query<{ library_chat_id: string }>(
        `SELECT library_chat_id::TEXT FROM telegram_links WHERE household_id = $1`,
        [auth.household_id],
      );
      if (!link.rows[0]) throw Object.assign(new Error("telegram_not_linked"), { statusCode: 409 });
      if (link.rows[0].library_chat_id !== origin[1])
        throw Object.assign(new Error("not_library_channel"), { statusCode: 403 });
      if (await blocksImport(db, auth.household_id, body.stable_source_key!, origin[2]!)) {
        throw Object.assign(new Error("source_removed"), { statusCode: 409 });
      }
      const {
        source_kind: _kind,
        phone_location: _l,
        source_fingerprint: _f,
        private: _p,
        attach_to_item_id: attachToId,
        attach_to_origin_identity: attachToIdentity,
        ...telegram
      } = body;
      let attachTo = attachToId;
      if (!attachTo && attachToIdentity) {
        const found = await db.query<{ media_item_id: string }>(
          `SELECT media_item_id FROM media_sources
            WHERE household_id = $1 AND kind = 'phone_local' AND origin_identity = $2 LIMIT 1`,
          [auth.household_id, attachToIdentity],
        );
        if (!found.rows[0]) throw Object.assign(new Error("not_found"), { statusCode: 404 });
        attachTo = found.rows[0].media_item_id;
      }
      if (attachTo) {
        const attached = await catalog.attachTelegramSource(db, auth.household_id, attachTo, {
          ...telegram,
          stable_source_key: body.stable_source_key!,
        });
        return reply.code(attached.created ? 201 : 200).send(attached);
      }
      const item = await catalog.importTelegramItem(db, auth.household_id, {
        ...telegram,
        stable_source_key: body.stable_source_key!,
      });
      if (body.poster_url) {
        for (const fn of hooks.onCatalogItemWrite) {
          await fn(db, auth.household_id, item.id, body.poster_url, !item.created);
        }
      }
      for (const fn of hooks.afterTelegramItemImported) {
        void Promise.resolve(fn(db, auth.household_id, body.stable_source_key!)).catch((error) =>
          console.warn(
            JSON.stringify({
              scope: "telegram-import-hook",
              event: "apply_failed",
              message: String(error),
            }),
          ),
        );
      }
      return reply.code(item.created ? 201 : 200).send(item);
    }
    const { source_kind: _kind, bytes_total: _b, playback_mime: _m, ...phone } = body;
    const item = await catalog.importItem(db, auth.household_id, phone);
    if (phone.poster_url) {
      for (const fn of hooks.onCatalogItemWrite) {
        await fn(db, auth.household_id, item.id, phone.poster_url, false);
      }
    }
    return reply.code(201).send(item);
  });

  const phoneOnly = async (req: Parameters<typeof requireAuth>[0]) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "phone") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    return auth;
  };
  const sourceKey = z.string().regex(/^tgfile:[A-Za-z0-9_-]{8,200}$/);

  app.post("/api/catalog/items/:itemId/removal", async (req) => {
    const auth = await phoneOnly(req);
    const itemId = z.string().uuid().parse((req.params as { itemId: string }).itemId);
    const body = z
      .discriminatedUnion("mode", [
        z.object({ mode: z.literal("hide") }).strict(),
        z.object({ mode: z.literal("delete") }).strict(),
        z.object({ mode: z.literal("delete_source"), stable_source_key: sourceKey }).strict(),
      ])
      .parse(req.body);
    return removeItem(
      db,
      auth.household_id,
      itemId,
      body.mode,
      body.mode === "delete_source" ? body.stable_source_key : undefined,
    );
  });

  app.get("/api/catalog/tombstones", async (req) => {
    const auth = await phoneOnly(req);
    return { tombstones: await listTombstones(db, auth.household_id) };
  });

  app.post("/api/catalog/tombstones/:stableSourceKey/result", async (req) => {
    const auth = await phoneOnly(req);
    const key = sourceKey.parse((req.params as { stableSourceKey: string }).stableSourceKey);
    const body = z
      .discriminatedUnion("outcome", [
        z.object({ outcome: z.literal("deleted") }).strict(),
        z.object({ outcome: z.literal("failed"), error: z.string().max(500) }).strict(),
      ])
      .parse(req.body);
    return recordTombstoneResult(db, auth.household_id, key, body);
  });

  app.delete("/api/catalog/tombstones/:stableSourceKey", async (req) => {
    const auth = await phoneOnly(req);
    return restoreTombstone(
      db,
      auth.household_id,
      sourceKey.parse((req.params as { stableSourceKey: string }).stableSourceKey),
    );
  });

  app.post("/api/catalog/sources/telegram/reconcile", async (req) => {
    const auth = await requireAuth(req);
    const body = z
      .object({
        present: z.array(z.string().regex(/^tgfile:[A-Za-z0-9_-]{8,200}$/)).max(10_000),
      })
      .strict()
      .parse(req.body);
    const linked = await db.query(`SELECT 1 FROM telegram_links WHERE household_id = $1`, [
      auth.household_id,
    ]);
    if (!linked.rows[0]) throw Object.assign(new Error("telegram_not_linked"), { statusCode: 409 });
    return catalog.reconcileTelegramSources(db, auth.household_id, body.present);
  });

  app.post("/api/playback/resolve", async (req) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "tv") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    const body = z
      .object({
        media_item_id: z.string().uuid(),
        attempt_id: z.string().uuid().optional(),
      })
      .parse(req.body);
    const authorizePrivate = async (isPrivate: boolean) => {
      if (!isPrivate) return;
      if (!body.attempt_id)
        throw Object.assign(new Error("approval_required"), { statusCode: 403 });
      const consumed = await db.query<{ id: string }>(
        `UPDATE private_playback_grants SET status = 'consumed', consumed_at = NOW()
          WHERE attempt_id = $1 AND household_id = $2 AND tv_device_id = $3
            AND media_item_id = $4 AND status = 'approved' AND expires_at > NOW()
          RETURNING id`,
        [body.attempt_id, auth.household_id, auth.device_id, body.media_item_id],
      );
      if (!consumed.rows[0])
        throw Object.assign(new Error("approval_required"), { statusCode: 403 });
    };
    for (const resolver of hooks.playbackResolvers) {
      const resolved = await resolver({
        db,
        householdId: auth.household_id,
        tvDeviceId: auth.device_id,
        mediaItemId: body.media_item_id,
        attemptId: body.attempt_id,
        authorizePrivate,
      });
      if (resolved) return resolved;
    }
    throw Object.assign(new Error("source_unavailable"), { statusCode: 404 });
  });

  app.patch("/api/catalog/items/:itemId", async (req, reply) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "phone") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    const itemId = z.string().uuid().parse((req.params as { itemId: string }).itemId);
    const body = z
      .object({
        title: z.string().trim().min(1).max(500).optional(),
        year: z.number().int().min(1).max(9999).nullable().optional(),
        overview: z.string().trim().max(10000).nullable().optional(),
        media_type: z.enum(["movie", "tv"]).optional(),
        expected_revision: z.number().int().nonnegative().optional(),
        edit_id: z.string().uuid().optional(),
      })
      .strict()
      .refine((b) => [b.title, b.year, b.overview, b.media_type].some((v) => v !== undefined))
      .refine((b) => (b.expected_revision === undefined) === (b.edit_id === undefined))
      .parse(req.body);
    const result = await patchMetadata(db, auth.household_id, itemId, body);
    if (result.conflict) {
      return reply.code(409).send({ error: "metadata_conflict", current: result.item });
    }
    return result.item;
  });

  app.put("/api/profiles/:profileId/progress/:itemId", async (req) => {
    const auth = await requireAuth(req);
    const { profileId, itemId } = req.params as { profileId: string; itemId: string };
    const prof = await db.query<{ household_id: string }>(
      `SELECT household_id FROM profiles WHERE id = $1`,
      [profileId],
    );
    if (!prof.rows[0] || prof.rows[0].household_id !== auth.household_id) {
      throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    }
    const item = await db.query<{ hidden_at: string | null }>(
      `SELECT hidden_at FROM media_items WHERE id = $1 AND household_id = $2`,
      [z.string().uuid().parse(itemId), auth.household_id],
    );
    if (!item.rows[0]) throw Object.assign(new Error("not_found"), { statusCode: 404 });
    if (item.rows[0].hidden_at) throw Object.assign(new Error("media_deleted"), { statusCode: 410 });
    const body = z
      .object({
        position_seconds: z.number().transform(Math.round),
        duration_seconds: z.number().transform(Math.round).optional(),
        state: z.enum(["playing", "paused", "stopped", "completed"]),
        client_updated_at: z.string().optional(),
      })
      .parse(req.body);
    await upsertProgress(db, profileId, itemId, body);
    if (auth.scope === "tv") {
      for (const fn of hooks.onTvPlayback) {
        await fn(db, auth.household_id, auth.device_id, profileId, itemId, body);
      }
    }
    return { ok: true };
  });

  tvOnline = registerCommandRoutes(app, db);
  registerTelegramRoutes(app, db);

  if (coreConfig.requireTls) {
    app.addHook("onRequest", async (req, reply) => {
      const xf = req.headers["x-forwarded-proto"];
      if (xf && xf !== "https") return reply.code(400).send({ error: "tls_required" });
    });
  }

  return app;
}
