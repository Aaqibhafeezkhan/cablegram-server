import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "./authorize.ts";
import { expireTemporaryDevices } from "./trust.ts";
import type { PhoneClaims, TvClaims } from "../auth/jwt.ts";

/** A TV login request lives this long; TDLib refreshes the token about every 30 s and the TV re-posts it. */
export const TV_LOGIN_TTL_MS = 60_000;
/** A request for the Telegram password stays open this long; the phone's notification goes with it. */
export const TV_PASSWORD_TTL_MS = 5 * 60_000;
/** How often expired password requests (and any sealed bytes left in them) are cleared. */
const PASSWORD_SWEEP_MS = 60_000;
/** base64 (standard) of a DER public key (SPKI) and of the sealed password, bounded so a body can't be abused as storage. */
const SPKI_KEY = /^[A-Za-z0-9+/]{80,200}={0,2}$/;
const SEALED = /^[A-Za-z0-9+/]{120,4096}={0,2}$/;
const LOGIN_LINK = /^tg:\/\/login\?token=[A-Za-z0-9_=-]{16,512}$/;

/**
 * Telegram as cloud storage (spec 004, contracts/telegram-link.md). The control plane only brokers:
 * it stores the household's account id and library channel, and passes a TV's login link to the
 * household's phone for approval. Telegram sessions, codes and passwords never reach it (FR-001),
 * so every body is parsed strictly: unexpected fields are rejected, not ignored.
 */
export function registerTelegramRoutes(app: FastifyInstance, db: PGlite) {
  function fail(status: number, code: string, extra?: Record<string, unknown>): never {
    throw Object.assign(new Error(code), { statusCode: status, ...(extra ? { extra } : {}) });
  }

  /**
   * A web (iPhone PWA) token is a remote, not a Telegram client: it is refused on every phone route
   * unless that route passes `allowWeb`.
   */
  async function auth(req: FastifyRequest, scope: "phone" | "tv", allowWeb = false): Promise<PhoneClaims | TvClaims> {
    const claims = await requireAuth(req);
    if (claims.scope !== scope) fail(403, "forbidden");
    if (claims.scope === "phone" && claims.client === "web" && !allowWeb) fail(403, "forbidden_for_web_client");
    return claims;
  }

  async function householdPhone(householdId: string, deviceId: string | undefined) {
    if (!deviceId) return null;
    const r = await db.query(
      `SELECT id FROM devices WHERE id = $1 AND household_id = $2 AND kind = 'phone' AND revoked_at IS NULL`,
      [deviceId, householdId],
    );
    if (!r.rows[0]) fail(400, "unknown_phone_device");
    return deviceId;
  }

  /** False for a temporary TV without the owner's opt-in: it plays Telegram titles through the phone instead. */
  async function telegramDirect(tvDeviceId: string): Promise<boolean> {
    const r = await db.query<{ trust_level: string; telegram_direct_allowed: boolean }>(
      `SELECT trust_level, telegram_direct_allowed FROM devices WHERE id = $1`,
      [tvDeviceId],
    );
    const d = r.rows[0];
    return !d || d.trust_level !== "temporary" || d.telegram_direct_allowed;
  }

  async function expireStale(householdId: string) {
    await db.query(
      `UPDATE telegram_tv_logins SET state = 'expired', login_link = NULL, resolved_at = NOW()
       WHERE household_id = $1 AND state = 'pending' AND expires_at <= NOW()`,
      [householdId],
    );
  }

  async function link(householdId: string) {
    const r = await db.query<{ telegram_user_id: string; display_name: string; library_chat_id: string; linked_at: string; linked_by_device_id: string | null; two_step: boolean | null }>(
      `SELECT telegram_user_id::TEXT, display_name, library_chat_id::TEXT, linked_at, linked_by_device_id, two_step FROM telegram_links WHERE household_id = $1`,
      [householdId],
    );
    return r.rows[0] ?? null;
  }

  // Application credentials only: account sessions and login secrets remain on each device.
  app.get("/api/telegram/client-config", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    reply.header("Pragma", "no-cache");
    const claims = await requireAuth(req);
    if (claims.scope === "phone" && claims.client === "web") fail(403, "forbidden_for_web_client");
    if (claims.scope === "tv" && !await telegramDirect(claims.device_id)) fail(403, "telegram_direct_not_allowed");
    const apiId = process.env.TELEGRAM_API_ID?.trim() ?? "";
    const apiHash = process.env.TELEGRAM_API_HASH?.trim() ?? "";
    if (!/^[1-9][0-9]*$/.test(apiId) || Number(apiId) > 2147483647 || !/^[a-fA-F0-9]{32}$/.test(apiHash)) {
      fail(503, "telegram_client_unavailable");
    }
    return { api_id: Number(apiId), api_hash: apiHash };
  });

  // ---- Household link ----

  app.get("/api/telegram/link", async (req) => {
    const claims = await requireAuth(req);
    const row = await link(claims.household_id);
    let logoutRequired = false;
    let direct = true;
    if (claims.scope === "tv") {
      const s = await db.query<{ logout_required: boolean }>(
        `SELECT logout_required FROM telegram_tv_state WHERE tv_device_id = $1`,
        [claims.device_id],
      );
      logoutRequired = s.rows[0]?.logout_required ?? false;
      direct = await telegramDirect(claims.device_id);
    }
    let trust: { trust_level: string; trust_expires_at: string | null } = { trust_level: "home", trust_expires_at: null };
    if (claims.scope === "tv") {
      const d = await db.query<{ trust_level: string; trust_expires_at: string | null }>(
        `SELECT trust_level, trust_expires_at FROM devices WHERE id = $1`, [claims.device_id],
      );
      if (d.rows[0]) trust = { trust_level: d.rows[0].trust_level, trust_expires_at: d.rows[0].trust_expires_at ? new Date(d.rows[0].trust_expires_at).toISOString() : null };
    }
    const tvFields = claims.scope === "tv" ? { telegram_logout_required: logoutRequired, telegram_direct: direct, ...trust } : {};
    if (!row) return { linked: false, ...tvFields };
    return {
      linked: true,
      // Telegram ids exceed 2^53 for channels; sent as numbers only when safe, else as strings.
      telegram_user_id: jsonId(row.telegram_user_id),
      display_name: row.display_name,
      library_chat_id: jsonId(row.library_chat_id),
      linked_at: new Date(row.linked_at).toISOString(),
      // The phone whose Telegram session can stream titles to a TV that holds none (US8).
      phone_device_id: row.linked_by_device_id,
      // Two-step verification on the account (null: unknown). A TV asks for the password before signing in.
      two_step: row.two_step,
      ...tvFields,
    };
  });

  // The phone reports whether the linked account has two-step verification; never the password or its hint.
  app.put("/api/telegram/link/two-step", async (req, reply) => {
    const claims = await auth(req, "phone");
    const body = z.object({ two_step: z.boolean() }).strict().parse(req.body);
    const r = await db.query(`UPDATE telegram_links SET two_step = $2 WHERE household_id = $1`, [claims.household_id, body.two_step]);
    if ((r.affectedRows ?? 0) === 0) fail(409, "telegram_not_linked");
    return reply.code(204).send();
  });

  app.put("/api/telegram/link", async (req) => {
    // A phone links after its own Telegram session is Ready. A TV may link too, but only a household
    // with no link yet (an iPhone-only household, whose TV is the only Telegram client).
    const claims = await requireAuth(req);
    if (claims.scope === "phone" && claims.client === "web") fail(403, "forbidden_for_web_client");
    const body = z.object({
      telegram_user_id: telegramId,
      display_name: z.string().trim().min(1).max(128),
      library_chat_id: telegramId,
      phone_device_id: z.string().uuid().optional(),
    }).strict().parse(req.body);
    const existing = await link(claims.household_id);
    if (claims.scope === "tv") {
      if (body.phone_device_id) fail(400, "invalid_request");
      if (existing) fail(403, "forbidden");
    }
    const phoneId = claims.scope === "phone" ? await householdPhone(claims.household_id, body.phone_device_id) : null;
    if (existing && existing.telegram_user_id !== String(body.telegram_user_id)) {
      fail(409, "telegram_account_mismatch", { linked_display_name: existing.display_name });
    }
    await db.query(
      `INSERT INTO telegram_links (household_id, telegram_user_id, display_name, library_chat_id, linked_by_device_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (household_id) DO UPDATE SET display_name = EXCLUDED.display_name,
         library_chat_id = EXCLUDED.library_chat_id,
         linked_by_device_id = COALESCE(EXCLUDED.linked_by_device_id, telegram_links.linked_by_device_id)`,
      [claims.household_id, String(body.telegram_user_id), body.display_name, String(body.library_chat_id), phoneId],
    );
    // Disconnecting marked the channel's videos unavailable; relinking the same channel brings its titles back at once
    // (US7). The next channel scan marks any deleted meanwhile unavailable again.
    if (!existing) await db.query(
      `UPDATE media_sources SET availability = 'available'
       WHERE household_id = $1 AND kind = 'telegram' AND availability = 'unavailable'
         AND split_part(origin_identity, ':', 2) = $2
         AND NOT EXISTS (SELECT 1 FROM source_tombstones t WHERE t.household_id = media_sources.household_id
                           AND t.stable_source_key = media_sources.stable_source_key)`,
      [claims.household_id, String(body.library_chat_id)],
    );
    // A fresh link supersedes any earlier "log out" instruction.
    await db.query(
      `UPDATE telegram_tv_state SET logout_required = FALSE, updated_at = NOW()
       WHERE tv_device_id IN (SELECT id FROM devices WHERE household_id = $1)`,
      [claims.household_id],
    );
    const row = (await link(claims.household_id))!;
    return {
      linked: true,
      telegram_user_id: jsonId(row.telegram_user_id),
      display_name: row.display_name,
      library_chat_id: jsonId(row.library_chat_id),
      linked_at: new Date(row.linked_at).toISOString(),
    };
  });

  app.delete("/api/telegram/link", async (req, reply) => {
    const claims = await auth(req, "phone");
    await db.query(`DELETE FROM telegram_links WHERE household_id = $1`, [claims.household_id]);
    await db.query(
      `UPDATE telegram_tv_logins SET state = 'expired', login_link = NULL, resolved_at = NOW()
       WHERE household_id = $1 AND state = 'pending'`,
      [claims.household_id],
    );
    await db.query(
      `INSERT INTO telegram_tv_state (tv_device_id, logout_required)
       SELECT id, TRUE FROM devices WHERE household_id = $1 AND kind = 'tv' AND revoked_at IS NULL
       ON CONFLICT (tv_device_id) DO UPDATE SET logout_required = TRUE, updated_at = NOW()`,
      [claims.household_id],
    );
    await db.query(
      `UPDATE media_sources SET availability = 'unavailable' WHERE household_id = $1 AND kind = 'telegram'`,
      [claims.household_id],
    );
    return reply.code(204).send();
  });

  app.post("/api/telegram/logout-ack", async (req, reply) => {
    const claims = (await auth(req, "tv")) as TvClaims;
    z.object({}).strict().parse(req.body ?? {});
    await db.query(
      `UPDATE telegram_tv_state SET logout_required = FALSE, updated_at = NOW() WHERE tv_device_id = $1`,
      [claims.device_id],
    );
    return reply.code(204).send();
  });

  // ---- Telegram sessions held by TVs, ended by the phone (US8) ----

  const tvIdParam = z.object({ tvDeviceId: z.string().uuid() });

  async function householdTv(householdId: string, tvDeviceId: string) {
    const r = await db.query(`SELECT 1 FROM devices WHERE id = $1 AND household_id = $2 AND kind = 'tv'`, [tvDeviceId, householdId]);
    if (!r.rows[0]) fail(404, "not_found");
  }

  app.put("/api/telegram/tv-sessions/:tvDeviceId", async (req) => {
    const claims = await auth(req, "phone");
    const { tvDeviceId } = tvIdParam.parse(req.params);
    const body = z.object({
      telegram_session_id: z.string().regex(/^-?\d{1,20}$/),
      approved_at: z.string().datetime().optional(),
      expires_at: z.string().datetime().nullable().optional(),
    }).strict().parse(req.body);
    await householdTv(claims.household_id, tvDeviceId);
    const active = await db.query(`SELECT 1 FROM devices WHERE id = $1 AND revoked_at IS NULL`, [tvDeviceId]);
    if (!active.rows[0]) fail(409, "device_revoked");
    await db.query(
      `INSERT INTO telegram_tv_sessions (tv_device_id, household_id, telegram_session_id, approved_at, expires_at)
       VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()), $5)
       ON CONFLICT (tv_device_id) DO UPDATE SET telegram_session_id = EXCLUDED.telegram_session_id,
         approved_at = EXCLUDED.approved_at, expires_at = EXCLUDED.expires_at,
         sign_out_at = NULL, terminated_at = NULL, outcome = NULL, last_error = NULL, updated_at = NOW()`,
      [tvDeviceId, claims.household_id, body.telegram_session_id, body.approved_at ?? null, body.expires_at ?? null],
    );
    return { ok: true };
  });

  app.get("/api/telegram/tv-sessions", async (req) => {
    const claims = await auth(req, "phone");
    z.object({ due: z.literal("true") }).parse(req.query);
    await expireTemporaryDevices(db, claims.household_id);
    const linked = Boolean(await link(claims.household_id));
    const r = await db.query<{ tv_device_id: string; telegram_session_id: string; reason: string }>(
      `SELECT s.tv_device_id, s.telegram_session_id,
              CASE WHEN s.sign_out_at IS NOT NULL THEN 'sign_out'
                   WHEN NOT $2::boolean THEN 'disconnected'
                   WHEN d.revoked_at IS NOT NULL AND d.revoked_reason = 'expired' THEN 'expired'
                   WHEN d.revoked_at IS NOT NULL THEN 'removed'
                   ELSE 'expired' END AS reason
         FROM telegram_tv_sessions s JOIN devices d ON d.id = s.tv_device_id
        WHERE s.household_id = $1 AND s.terminated_at IS NULL
          AND (s.sign_out_at IS NOT NULL OR NOT $2::boolean OR d.revoked_at IS NOT NULL
               OR (s.expires_at IS NOT NULL AND s.expires_at <= NOW()))
        ORDER BY s.approved_at`,
      [claims.household_id, linked],
    );
    return { sessions: r.rows };
  });

  app.post("/api/telegram/tv-sessions/:tvDeviceId/terminated", async (req) => {
    const claims = await auth(req, "phone");
    const { tvDeviceId } = tvIdParam.parse(req.params);
    const body = z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("terminated") }).strict(),
      z.object({ outcome: z.literal("already_gone") }).strict(),
      z.object({ outcome: z.literal("failed"), error: z.string().regex(/^[A-Z0-9_ ]{1,80}$/) }).strict(),
    ]).parse(req.body);
    const r = await db.query(
      body.outcome === "failed"
        ? `UPDATE telegram_tv_sessions SET last_error = $3, updated_at = NOW()
            WHERE tv_device_id = $1 AND household_id = $2 AND terminated_at IS NULL`
        : `UPDATE telegram_tv_sessions SET terminated_at = NOW(), outcome = $3, last_error = NULL, updated_at = NOW()
            WHERE tv_device_id = $1 AND household_id = $2 AND terminated_at IS NULL`,
      [tvDeviceId, claims.household_id, body.outcome === "failed" ? body.error : body.outcome],
    );
    if (r.affectedRows !== 1) fail(404, "not_found");
    return { ok: true };
  });

  app.post("/api/telegram/tv-sessions/:tvDeviceId/sign-out", async (req) => {
    const claims = await auth(req, "phone");
    const { tvDeviceId } = tvIdParam.parse(req.params);
    z.object({}).strict().parse(req.body ?? {});
    await householdTv(claims.household_id, tvDeviceId);
    await db.query(
      `UPDATE telegram_tv_sessions SET sign_out_at = NOW(), updated_at = NOW()
        WHERE tv_device_id = $1 AND household_id = $2 AND terminated_at IS NULL`,
      [tvDeviceId, claims.household_id],
    );
    await db.query(
      `INSERT INTO telegram_tv_state (tv_device_id, logout_required) VALUES ($1, TRUE)
       ON CONFLICT (tv_device_id) DO UPDATE SET logout_required = TRUE, updated_at = NOW()`,
      [tvDeviceId],
    );
    return { ok: true };
  });

  // ---- Phone login, approved by a Home TV (FR-023): the reverse of the TV login below ----

  async function expireStalePhoneLogins(householdId: string) {
    await db.query(
      `UPDATE telegram_phone_logins SET state = 'expired', login_link = NULL, resolved_at = NOW()
       WHERE household_id = $1 AND state = 'pending' AND expires_at <= NOW()`,
      [householdId],
    );
  }

  app.post("/api/telegram/phone-logins", async (req, reply) => {
    const claims = await auth(req, "phone");
    const body = z.object({
      login_link: z.string().regex(LOGIN_LINK),
      tv_device_id: z.string().uuid(),
      // Which phone asks: the TV shows its name and the owner confirms on the TV (review fix).
      phone_device_id: z.string().uuid(),
    }).strict().parse(req.body);
    const tv = await db.query<{ trust_level: string }>(
      `SELECT trust_level FROM devices WHERE id = $1 AND household_id = $2 AND kind = 'tv' AND revoked_at IS NULL`,
      [body.tv_device_id, claims.household_id],
    );
    if (!tv.rows[0]) fail(404, "not_found");
    // A TV the owner does not control must never be able to approve a login to the owner's account.
    if (tv.rows[0]!.trust_level !== "home") fail(403, "tv_not_home");
    const phone = await db.query(
      `SELECT id FROM devices WHERE id = $1 AND household_id = $2 AND kind = 'phone' AND revoked_at IS NULL`,
      [body.phone_device_id, claims.household_id],
    );
    if (!phone.rows[0]) fail(400, "unknown_phone_device");
    await db.query(
      `UPDATE telegram_phone_logins SET state = 'expired', login_link = NULL, resolved_at = NOW()
       WHERE household_id = $1 AND state = 'pending'`,
      [claims.household_id],
    );
    const id = randomUUID();
    await db.query(
      `INSERT INTO telegram_phone_logins (id, household_id, tv_device_id, phone_device_id, login_link, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' milliseconds')::INTERVAL)`,
      [id, claims.household_id, body.tv_device_id, body.phone_device_id, body.login_link, String(TV_LOGIN_TTL_MS)],
    );
    return reply.code(201).send({ request_id: id, expires_in_ms: TV_LOGIN_TTL_MS });
  });

  app.get("/api/telegram/phone-logins/pending", async (req) => {
    const claims = (await auth(req, "tv")) as TvClaims;
    await expireStalePhoneLogins(claims.household_id);
    // Only while this TV is a Home TV now: a request made before it was switched to temporary is not offered.
    const r = await db.query<{ id: string; login_link: string; expires_in_ms: number; phone_name: string | null }>(
      `SELECT l.id, l.login_link, p.display_name AS phone_name,
              GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (l.expires_at - NOW())) * 1000))::INT AS expires_in_ms
         FROM telegram_phone_logins l
         JOIN devices t ON t.id = l.tv_device_id AND t.trust_level = 'home' AND t.revoked_at IS NULL
         JOIN devices p ON p.id = l.phone_device_id AND p.revoked_at IS NULL
        WHERE l.tv_device_id = $1 AND l.state = 'pending' ORDER BY l.created_at`,
      [claims.device_id],
    );
    return {
      requests: r.rows.map((row) => ({
        request_id: row.id,
        login_link: row.login_link,
        phone_name: row.phone_name || "Phone",
        expires_in_ms: Number(row.expires_in_ms),
      })),
    };
  });

  app.post("/api/telegram/phone-logins/:id/result", async (req) => {
    const claims = (await auth(req, "tv")) as TvClaims;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      outcome: z.enum(["approved", "denied", "failed"]),
      error: z.string().regex(/^[A-Z0-9_ ]{1,80}$/).optional(),
    }).strict().parse(req.body);
    await expireStalePhoneLogins(claims.household_id);
    const r = await db.query<{ state: string }>(
      `SELECT state FROM telegram_phone_logins WHERE id = $1 AND tv_device_id = $2`,
      [id, claims.device_id],
    );
    if (!r.rows[0]) fail(404, "not_found");
    if (r.rows[0].state !== "pending") fail(409, "already_resolved", { state: r.rows[0].state });
    await db.query(
      `UPDATE telegram_phone_logins SET state = $2, error = $3, login_link = NULL, resolved_at = NOW() WHERE id = $1`,
      [id, body.outcome, body.outcome === "failed" ? body.error ?? "UNKNOWN" : null],
    );
    return { request_id: id, state: body.outcome };
  });

  app.get("/api/telegram/phone-logins/:id", async (req) => {
    const claims = await auth(req, "phone");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await expireStalePhoneLogins(claims.household_id);
    const r = await db.query<{ state: string; error: string | null }>(
      `SELECT state, error FROM telegram_phone_logins WHERE id = $1 AND household_id = $2`,
      [id, claims.household_id],
    );
    if (!r.rows[0]) fail(404, "not_found");
    return { request_id: id, state: r.rows[0].state, error: r.rows[0].error };
  });

  // ---- TV login, approved by the phone ----

  app.post("/api/telegram/tv-logins", async (req, reply) => {
    const claims = (await auth(req, "tv")) as TvClaims;
    const body = z.object({ login_link: z.string().regex(LOGIN_LINK) }).strict().parse(req.body);
    if (!(await link(claims.household_id))) fail(409, "telegram_not_linked");
    if (!(await telegramDirect(claims.device_id))) fail(403, "telegram_not_allowed_on_temporary_tv");
    // The newest link replaces an earlier pending one from the same TV.
    await db.query(
      `UPDATE telegram_tv_logins SET state = 'expired', login_link = NULL, resolved_at = NOW()
       WHERE tv_device_id = $1 AND state = 'pending'`,
      [claims.device_id],
    );
    const id = randomUUID();
    await db.query(
      `INSERT INTO telegram_tv_logins (id, household_id, tv_device_id, login_link, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + ($5 || ' milliseconds')::INTERVAL)`,
      [id, claims.household_id, claims.device_id, body.login_link, String(TV_LOGIN_TTL_MS)],
    );
    return reply.code(201).send({ request_id: id, expires_in_ms: TV_LOGIN_TTL_MS });
  });

  app.get("/api/telegram/tv-logins/pending", async (req) => {
    const claims = await auth(req, "phone", true);
    await expireStale(claims.household_id);
    const r = await db.query<{ id: string; tv_device_id: string; display_name: string; login_link: string; expires_in_ms: number }>(
      `SELECT l.id, l.tv_device_id, d.display_name, l.login_link,
              GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (l.expires_at - NOW())) * 1000))::INT AS expires_in_ms
       FROM telegram_tv_logins l JOIN devices d ON d.id = l.tv_device_id
       WHERE l.household_id = $1 AND l.state = 'pending' AND d.revoked_at IS NULL
       ORDER BY l.created_at`,
      [claims.household_id],
    );
    return {
      requests: r.rows.map((row) => ({
        request_id: row.id,
        tv_device_id: row.tv_device_id,
        tv_name: row.display_name || "TV",
        login_link: row.login_link,
        expires_in_ms: Number(row.expires_in_ms),
      })),
    };
  });

  app.post("/api/telegram/tv-logins/:id/result", async (req) => {
    const claims = (await auth(req, "phone", true)) as PhoneClaims;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      outcome: z.enum(["approved", "denied", "failed"]),
      // Telegram error names only, e.g. SESSION_TOO_FRESH_1234; never free text that could carry a secret.
      error: z.string().regex(/^[A-Z0-9_ ]{1,80}$/).optional(),
    }).strict().parse(req.body);
    // A web client can't check the new Telegram session, so it can't vouch for a failure either.
    if (claims.client === "web" && body.outcome === "failed") fail(403, "forbidden_for_web_client");
    await expireStale(claims.household_id);
    const r = await db.query<{ state: string; tv_device_id: string }>(
      `SELECT state, tv_device_id FROM telegram_tv_logins WHERE id = $1 AND household_id = $2`,
      [id, claims.household_id],
    );
    const row = r.rows[0];
    if (!row) fail(404, "not_found");
    if (row.state !== "pending") fail(409, "already_resolved", { state: row.state });
    await db.query(
      `UPDATE telegram_tv_logins SET state = $2, error = $3, login_link = NULL, resolved_at = NOW() WHERE id = $1`,
      [id, body.outcome, body.outcome === "failed" ? body.error ?? "UNKNOWN" : null],
    );
    if (body.outcome === "approved") {
      // A TV signed out earlier and now approved again: the old "log out" instruction no longer applies.
      await db.query(`UPDATE telegram_tv_state SET logout_required = FALSE, updated_at = NOW() WHERE tv_device_id = $1`, [row.tv_device_id]);
    }
    return { request_id: id, state: body.outcome };
  });

  app.get("/api/telegram/tv-logins/:id", async (req) => {
    const claims = (await auth(req, "tv")) as TvClaims;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await expireStale(claims.household_id);
    const r = await db.query<{ state: string; error: string | null }>(
      `SELECT state, error FROM telegram_tv_logins WHERE id = $1 AND tv_device_id = $2`,
      [id, claims.device_id],
    );
    if (!r.rows[0]) fail(404, "not_found");
    return { request_id: id, state: r.rows[0].state, error: r.rows[0].error };
  });

  // ---- The Telegram two-step password, typed on the phone and sealed to the TV ----
  // The control plane relays bytes it cannot read: the TV's one-time public key and the phone's sealed reply.

  async function expirePasswordRequests(householdId?: string) {
    await db.query(
      `UPDATE telegram_tv_password_requests SET state = 'expired', sealed = NULL, resolved_at = NOW()
       WHERE ($1::UUID IS NULL OR household_id = $1) AND state IN ('pending', 'sealed') AND expires_at <= NOW()`,
      [householdId ?? null],
    );
  }
  // Sealed bytes nobody collects (the TV signed in another way, or went away) are dropped when the request expires,
  // not only when a device of that household next asks.
  const passwordSweep = setInterval(() => { void expirePasswordRequests().catch(() => undefined); }, PASSWORD_SWEEP_MS);
  passwordSweep.unref();
  app.addHook("onClose", async () => clearInterval(passwordSweep));

  app.post("/api/telegram/tv-password-requests", async (req, reply) => {
    const claims = (await auth(req, "tv")) as TvClaims;
    const body = z.object({
      public_key: z.string().regex(SPKI_KEY),
      hint: z.string().max(200).optional(),
    }).strict().parse(req.body);
    if (!(await link(claims.household_id))) fail(409, "telegram_not_linked");
    if (!(await telegramDirect(claims.device_id))) fail(403, "telegram_not_allowed_on_temporary_tv");
    // The newest request replaces an earlier open one from the same TV.
    await db.query(
      `UPDATE telegram_tv_password_requests SET state = 'cancelled', sealed = NULL, resolved_at = NOW()
       WHERE tv_device_id = $1 AND state IN ('pending', 'sealed')`,
      [claims.device_id],
    );
    const id = randomUUID();
    await db.query(
      `INSERT INTO telegram_tv_password_requests (id, household_id, tv_device_id, tv_public_key, hint, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' milliseconds')::INTERVAL)`,
      [id, claims.household_id, claims.device_id, body.public_key, body.hint ?? "", String(TV_PASSWORD_TTL_MS)],
    );
    return reply.code(201).send({ request_id: id, expires_in_ms: TV_PASSWORD_TTL_MS });
  });

  app.get("/api/telegram/tv-password-requests/pending", async (req) => {
    const claims = await auth(req, "phone");
    await expirePasswordRequests(claims.household_id);
    const r = await db.query<{ id: string; tv_device_id: string; display_name: string; tv_public_key: string; hint: string; expires_in_ms: number }>(
      `SELECT p.id, p.tv_device_id, d.display_name, p.tv_public_key, p.hint,
              GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (p.expires_at - NOW())) * 1000))::INT AS expires_in_ms
       FROM telegram_tv_password_requests p JOIN devices d ON d.id = p.tv_device_id
       WHERE p.household_id = $1 AND p.state = 'pending' AND d.revoked_at IS NULL
       ORDER BY p.created_at`,
      [claims.household_id],
    );
    return {
      requests: r.rows.map((row) => ({
        request_id: row.id,
        tv_device_id: row.tv_device_id,
        tv_name: row.display_name || "TV",
        tv_public_key: row.tv_public_key,
        hint: row.hint,
        expires_in_ms: Number(row.expires_in_ms),
      })),
    };
  });

  app.post("/api/telegram/tv-password-requests/:id/seal", async (req) => {
    const claims = await auth(req, "phone");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ sealed: z.string().regex(SEALED) }).strict().parse(req.body);
    await expirePasswordRequests(claims.household_id);
    // One conditional write, so a request cancelled or expired meanwhile is never turned back into a sealed one.
    const sealed = await db.query(
      `UPDATE telegram_tv_password_requests SET state = 'sealed', sealed = $3
        WHERE id = $1 AND household_id = $2 AND state = 'pending' AND expires_at > NOW()`,
      [id, claims.household_id, body.sealed],
    );
    if (sealed.affectedRows !== 1) {
      const r = await db.query<{ state: string }>(
        `SELECT state FROM telegram_tv_password_requests WHERE id = $1 AND household_id = $2`,
        [id, claims.household_id],
      );
      if (!r.rows[0]) fail(404, "not_found");
      fail(409, "already_resolved", { state: r.rows[0]!.state });
    }
    return { request_id: id, state: "sealed" };
  });

  app.post("/api/telegram/tv-password-requests/:id/cancel", async (req) => {
    const claims = await auth(req, "phone");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await db.query(
      `UPDATE telegram_tv_password_requests SET state = 'cancelled', sealed = NULL, resolved_at = NOW()
       WHERE id = $1 AND household_id = $2 AND state IN ('pending', 'sealed')`,
      [id, claims.household_id],
    );
    if (r.affectedRows !== 1) fail(404, "not_found");
    return { request_id: id, state: "cancelled" };
  });

  /** The TV no longer needs the password (signed in another way, or gave up): the phone's notification goes away. */
  app.delete("/api/telegram/tv-password-requests/:id", async (req) => {
    const claims = (await auth(req, "tv")) as TvClaims;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await db.query(
      `UPDATE telegram_tv_password_requests SET state = 'cancelled', sealed = NULL, resolved_at = NOW()
       WHERE id = $1 AND tv_device_id = $2 AND state IN ('pending', 'sealed')`,
      [id, claims.device_id],
    );
    if (r.affectedRows !== 1) fail(404, "not_found");
    return { request_id: id, state: "cancelled" };
  });

  /** The TV reads the sealed password once: it is deleted from the control plane as it is handed over. */
  app.get("/api/telegram/tv-password-requests/:id", async (req) => {
    const claims = (await auth(req, "tv")) as TvClaims;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await expirePasswordRequests(claims.household_id);
    return db.transaction(async (tx) => {
      const r = await tx.query<{ state: string; sealed: string | null }>(
        `SELECT state, sealed FROM telegram_tv_password_requests WHERE id = $1 AND tv_device_id = $2`,
        [id, claims.device_id],
      );
      const row = r.rows[0];
      if (!row) return fail(404, "not_found");
      if (row.state !== "sealed" || !row.sealed) return { request_id: id, state: row.state };
      await tx.query(
        `UPDATE telegram_tv_password_requests SET state = 'delivered', sealed = NULL, resolved_at = NOW() WHERE id = $1`,
        [id],
      );
      return { request_id: id, state: "delivered", sealed: row.sealed };
    });
  });
}

/** Telegram user and chat ids: 64-bit integers, accepted as JSON numbers or decimal strings. */
const telegramId = z.union([
  z.number().int().refine((n) => Number.isSafeInteger(n), "unsafe_integer"),
  z.string().regex(/^-?\d{1,19}$/),
]);

function jsonId(value: string): number | string {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : value;
}
