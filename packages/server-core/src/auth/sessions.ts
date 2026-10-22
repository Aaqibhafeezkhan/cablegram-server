import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { hashToken, randomSecret } from "./secrets.ts";
import { signPhone } from "./jwt.ts";

const REFRESH_DAYS = 30;
const REUSE_GRACE_SECONDS = 60;

export type Client = "web" | undefined;

/** Starts a sign-in: a 2-hour access token and a single-use refresh token that begins a new chain. */
export async function issueSession(
  db: PGlite,
  userId: string,
  householdId: string,
  client: Client,
  chainId: string = randomUUID(),
  deviceId?: string,
) {
  const refresh = randomSecret();
  await db.query(
    `INSERT INTO sessions (id, user_id, device_id, refresh_token_hash, expires_at, client, chain_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      userId,
      deviceId ?? null,
      hashToken(refresh),
      new Date(Date.now() + REFRESH_DAYS * 864e5).toISOString(),
      client ?? "app",
      chainId,
    ],
  );
  return { access_token: await signPhone(userId, householdId, client), refresh_token: refresh };
}

/**
 * Rotation: each refresh token works once. Revoking it in the same statement that finds it means two concurrent
 * refreshes cannot both succeed. A token that was already used comes back only if someone kept a copy, so every
 * session of its chain is revoked and the person signs in again (spec 007 US6).
 */
export async function refreshSession(db: PGlite, refreshToken: string) {
  const hash = hashToken(refreshToken);
  const r = await db.query<{ user_id: string; household_id: string; client: string; chain_id: string | null; device_id: string | null }>(
    `UPDATE sessions s SET revoked_at = NOW()
       FROM users u
      WHERE u.id = s.user_id AND s.refresh_token_hash = $1
        AND s.revoked_at IS NULL AND s.expires_at > NOW()
        AND (s.device_id IS NULL OR EXISTS (SELECT 1 FROM devices d WHERE d.id = s.device_id AND d.revoked_at IS NULL))
     RETURNING s.user_id, u.household_id, s.client, s.chain_id, s.device_id`,
    [hash],
  );
  const row = r.rows[0];
  if (!row) {
    await db.query(
      `UPDATE sessions SET revoked_at = NOW()
        WHERE revoked_at IS NULL
          AND chain_id = (SELECT chain_id FROM sessions WHERE refresh_token_hash = $1
                             AND revoked_at < NOW() - ($2 || ' seconds')::interval)`,
      [hash, String(REUSE_GRACE_SECONDS)],
    );
    return null;
  }
  const client: Client = row.client === "web" ? "web" : undefined;
  return {
    userId: row.user_id,
    householdId: row.household_id,
    ...(await issueSession(db, row.user_id, row.household_id, client, row.chain_id ?? randomUUID(), row.device_id ?? undefined)),
  };
}
