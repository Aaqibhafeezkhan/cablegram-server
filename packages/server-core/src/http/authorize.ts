import type { FastifyRequest } from "fastify";
import type { PGlite } from "@electric-sql/pglite";
import { verifyAccess, type PhoneClaims, type TvClaims } from "../auth/jwt.ts";
import { coreConfig } from "../config.ts";
import { expireTemporaryDevices } from "./trust.ts";

type ActivityHook = (db: PGlite, householdId: string, userId?: string) => Promise<void> | void;
type DbHolder = { db?: PGlite; onActivity?: ActivityHook };

const revocationCache = new Map<string, { revoked: "revoked" | "expired" | null; at: number }>();
const RECHECK_SECONDS = 30;

export function configureAuthDb(db: PGlite, onActivity?: ActivityHook) {
  (coreConfig as DbHolder).db = db;
  (coreConfig as DbHolder).onActivity = onActivity;
}

async function isTvRevoked(deviceId: string): Promise<"revoked" | "expired" | null> {
  const db = (coreConfig as DbHolder).db;
  if (!db) throw revocationCheckUnavailable();
  const cached = revocationCache.get(deviceId);
  const now = Date.now();
  if (cached && now - cached.at < RECHECK_SECONDS * 1000) return cached.revoked;
  let revoked: "revoked" | "expired" | null;
  try {
    await expireTemporaryDevices(db, undefined, deviceId);
    const r = await db.query<{ revoked_at: string | null; revoked_reason: string | null }>(
      `SELECT revoked_at, revoked_reason FROM devices WHERE id = $1`,
      [deviceId],
    );
    const row = r.rows[0];
    revoked = !row ? "revoked" : !row.revoked_at ? null : row.revoked_reason === "expired" ? "expired" : "revoked";
  } catch {
    throw revocationCheckUnavailable();
  }
  revocationCache.set(deviceId, { revoked, at: Date.now() });
  return revoked;
}

const userCache = new Map<string, { householdId: string | null; at: number }>();

async function phoneUserHousehold(userId: string): Promise<string | null> {
  const db = (coreConfig as DbHolder).db;
  if (!db) throw revocationCheckUnavailable();
  const cached = userCache.get(userId);
  if (cached && Date.now() - cached.at < RECHECK_SECONDS * 1000) return cached.householdId;
  let householdId: string | null;
  try {
    const r = await db.query<{ household_id: string }>(`SELECT household_id FROM users WHERE id = $1`, [userId]);
    householdId = r.rows[0]?.household_id ?? null;
  } catch {
    throw revocationCheckUnavailable();
  }
  userCache.set(userId, { householdId, at: Date.now() });
  return householdId;
}

export async function requireAuth(req: FastifyRequest): Promise<PhoneClaims | TvClaims> {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) {
    throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
  }
  let claims: PhoneClaims | TvClaims;
  try {
    claims = await verifyAccess(h.slice(7));
  } catch {
    throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
  }
  if (claims.scope === "tv") {
    const revoked = await isTvRevoked(claims.device_id);
    if (revoked) throw Object.assign(new Error(revoked === "expired" ? "device_expired" : "device_revoked"), { statusCode: 401 });
  } else if ((await phoneUserHousehold(claims.user_id)) !== claims.household_id) {
    throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
  }
  const holder = coreConfig as DbHolder;
  if (holder.db && holder.onActivity) {
    await holder.onActivity(holder.db, claims.household_id, claims.scope === "phone" ? claims.user_id : undefined);
  }
  return claims;
}

function revocationCheckUnavailable() {
  return Object.assign(new Error("revocation_check_unavailable"), { statusCode: 503 });
}

export function clearRevocation(deviceId: string) {
  revocationCache.delete(deviceId);
}

export function clearUserCheck(userId: string) {
  userCache.delete(userId);
}

export function assertHousehold(auth: PhoneClaims | TvClaims, householdId: string) {
  if (auth.household_id !== householdId) {
    throw Object.assign(new Error("forbidden"), { statusCode: 403 });
  }
}
