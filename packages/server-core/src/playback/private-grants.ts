import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { hashToken, randomSecret } from "../auth/secrets.ts";

const GRANT_TTL_MS = 5 * 60 * 1000;

export type PrivateToken = { attemptId: string; token: string };

export async function createPrivateApprovalRequest(
  db: PGlite,
  householdId: string,
  profileId: string | null,
  tvDeviceId: string,
  mediaItemId: string,
  mediaSourceId: string | null,
): Promise<{ id: string; attempt_id: string; expires_at: string }> {
  const attemptId = randomUUID();
  const expires = new Date(Date.now() + GRANT_TTL_MS).toISOString();
  const id = randomUUID();
  await db.query(
    `INSERT INTO private_playback_grants
       (id, household_id, profile_id, tv_device_id, media_item_id, media_source_id, attempt_id, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
    [id, householdId, profileId, tvDeviceId, mediaItemId, mediaSourceId, attemptId, expires],
  );
  return { id, attempt_id: attemptId, expires_at: expires };
}

export async function grantStatus(db: PGlite, householdId: string, attemptId: string) {
  const r = await db.query<{ status: string; expires_at: string }>(
    `SELECT status, expires_at FROM private_playback_grants WHERE attempt_id = $1 AND household_id = $2`,
    [attemptId, householdId],
  );
  return r.rows[0] ?? null;
}

export async function approve(
  db: PGlite,
  householdId: string,
  userId: string,
  attemptId: string,
): Promise<{ token: string; expires_at: string }> {
  const pending = await db.query<{ id: string; expires_at: string }>(
    `SELECT id, expires_at FROM private_playback_grants
     WHERE attempt_id = $1 AND household_id = $2 AND status = 'pending' AND expires_at > NOW()`,
    [attemptId, householdId],
  );
  if (!pending.rows[0]) {
    throw Object.assign(new Error("approval_not_pending"), { statusCode: 409 });
  }
  const token = randomSecret();
  await db.query(
    `UPDATE private_playback_grants
     SET status = 'approved', token_hash = $1, approved_by_user_id = $2
     WHERE id = $3`,
    [hashToken(token), userId, pending.rows[0].id],
  );
  return { token, expires_at: pending.rows[0].expires_at };
}

export async function deny(db: PGlite, householdId: string, attemptId: string): Promise<void> {
  const r = await db.query<{ id: string }>(
    `UPDATE private_playback_grants SET status = 'denied'
     WHERE attempt_id = $1 AND household_id = $2 AND status = 'pending'
     RETURNING id`,
    [attemptId, householdId],
  );
  if (r.rows.length === 0) {
    throw Object.assign(new Error("approval_not_pending"), { statusCode: 409 });
  }
}

export async function consume(
  db: PGlite,
  attemptId: string,
  token: string,
): Promise<boolean> {
  const r = await db.query<{ id: string }>(
    `UPDATE private_playback_grants
     SET status = 'consumed', consumed_at = NOW()
     WHERE attempt_id = $1 AND token_hash = $2 AND status = 'approved' AND expires_at > NOW()
     RETURNING id`,
    [attemptId, hashToken(token)],
  );
  return r.rows.length > 0;
}

const LAN_PASS_TTL_MS = 6 * 60 * 60 * 1000;

export async function startLanPlayback(
  db: PGlite,
  householdId: string,
  tvDeviceId: string,
  attemptId: string,
): Promise<{ lan_pass: string; expires_at: string } | null> {
  const pass = randomSecret();
  const expires = new Date(Date.now() + LAN_PASS_TTL_MS).toISOString();
  const r = await db.query<{ id: string }>(
    `UPDATE private_playback_grants
     SET status = 'consumed', consumed_at = NOW(), lan_pass_hash = $1, lan_pass_expires_at = $2
     WHERE attempt_id = $3 AND household_id = $4 AND tv_device_id = $5
       AND status = 'approved' AND expires_at > NOW()
     RETURNING id`,
    [hashToken(pass), expires, attemptId, householdId, tvDeviceId],
  );
  return r.rows[0] ? { lan_pass: pass, expires_at: expires } : null;
}

export async function verifyLanPass(db: PGlite, householdId: string, pass: string) {
  const r = await db.query<{ media_item_id: string; tv_device_id: string; lan_pass_expires_at: string }>(
    `SELECT media_item_id, tv_device_id, lan_pass_expires_at FROM private_playback_grants
     WHERE lan_pass_hash = $1 AND household_id = $2 AND lan_pass_expires_at > NOW()`,
    [hashToken(pass), householdId],
  );
  const grant = r.rows[0];
  if (!grant) return null;
  const sources = await db.query<{ origin_identity: string }>(
    `SELECT origin_identity FROM media_sources WHERE media_item_id = $1 AND kind = 'phone_local'`,
    [grant.media_item_id],
  );
  return {
    media_item_id: grant.media_item_id,
    tv_device_id: grant.tv_device_id,
    origin_identities: sources.rows.map((row) => row.origin_identity),
    expires_at: new Date(grant.lan_pass_expires_at).toISOString(),
  };
}

export async function expireStale(db: PGlite): Promise<void> {
  await db.query(
    `UPDATE private_playback_grants SET status = 'expired'
     WHERE status IN ('pending', 'approved') AND expires_at <= NOW()`,
  );
}
