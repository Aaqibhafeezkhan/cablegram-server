import type { PGlite } from "@electric-sql/pglite";
import { z } from "zod";

export const MAX_TEMPORARY_MS = 30 * 24 * 60 * 60 * 1000;
export const FRESH_LINK_MS = 24 * 60 * 60 * 1000;

export const trustFields = {
  trust_level: z.enum(["home", "temporary"]).optional(),
  trust_expires_at: z.string().datetime().nullable().optional(),
  telegram_direct_allowed: z.boolean().optional(),
};

type Trust = { trust_level?: "home" | "temporary"; trust_expires_at?: string | null; telegram_direct_allowed?: boolean };

const fail = (status: number, code: string): never => {
  throw Object.assign(new Error(code), { statusCode: status });
};

export async function validateTrust(db: PGlite, householdId: string, trust: Trust) {
  if ((trust.trust_level ?? "home") === "home") return;
  if (!trust.trust_expires_at) return fail(400, "trust_expires_at_required");
  const end = new Date(trust.trust_expires_at).getTime();
  if (end <= Date.now() || end > Date.now() + MAX_TEMPORARY_MS) return fail(400, "invalid_trust_expires_at");
  if (trust.telegram_direct_allowed === true) {
    const link = await db.query<{ linked_at: string }>(`SELECT linked_at FROM telegram_links WHERE household_id = $1`, [householdId]);
    if (link.rows[0] && Date.now() - new Date(link.rows[0].linked_at).getTime() < FRESH_LINK_MS) return fail(409, "telegram_link_too_new");
  }
}

export async function applyTrust(db: PGlite, householdId: string, deviceId: string, trust: Trust) {
  if (trust.trust_level === undefined && trust.trust_expires_at === undefined && trust.telegram_direct_allowed === undefined) return;
  const current = await db.query<{ trust_level: string; trust_expires_at: string | null; telegram_direct_allowed: boolean }>(
    `SELECT trust_level, trust_expires_at, telegram_direct_allowed FROM devices
      WHERE id = $1 AND household_id = $2 AND kind = 'tv' AND revoked_at IS NULL`,
    [deviceId, householdId],
  );
  if (!current.rows[0]) return fail(404, "not_found");
  const level = trust.trust_level ?? current.rows[0].trust_level;
  const expires = trust.trust_expires_at !== undefined ? trust.trust_expires_at : current.rows[0].trust_expires_at;
  let direct = trust.telegram_direct_allowed ?? current.rows[0].telegram_direct_allowed;
  if (level === "home") {
    await db.query(
      `UPDATE devices SET trust_level = 'home', trust_expires_at = NULL, telegram_direct_allowed = $2 WHERE id = $1`,
      [deviceId, trust.telegram_direct_allowed ?? false],
    );
    return;
  }
  if (!expires) return fail(400, "trust_expires_at_required");
  const end = new Date(expires).getTime();
  if (end <= Date.now() || end > Date.now() + MAX_TEMPORARY_MS) return fail(400, "invalid_trust_expires_at");
  if (direct && trust.telegram_direct_allowed === true) {
    const link = await db.query<{ linked_at: string }>(`SELECT linked_at FROM telegram_links WHERE household_id = $1`, [householdId]);
    if (link.rows[0] && Date.now() - new Date(link.rows[0].linked_at).getTime() < FRESH_LINK_MS) return fail(409, "telegram_link_too_new");
  }
  direct = Boolean(direct);
  await db.query(
    `UPDATE devices SET trust_level = 'temporary', trust_expires_at = $2, telegram_direct_allowed = $3 WHERE id = $1`,
    [deviceId, expires, direct],
  );
}

export async function expireTemporaryDevices(db: PGlite, householdId?: string, deviceId?: string) {
  await db.query(
    `UPDATE devices SET revoked_at = NOW(), revoked_reason = 'expired'
      WHERE trust_level = 'temporary' AND trust_expires_at <= NOW() AND revoked_at IS NULL
        AND ($1::uuid IS NULL OR household_id = $1) AND ($2::uuid IS NULL OR id = $2)`,
    [householdId ?? null, deviceId ?? null],
  );
}
