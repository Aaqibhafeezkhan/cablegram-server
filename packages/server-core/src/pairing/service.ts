import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { hashToken, pinLookup, randomPin, randomSecret } from "../auth/secrets.ts";
import { checkPinRate, clearPinFail, recordPinFail } from "./pin-rate-limit.ts";

export async function startPairing(db: PGlite, deviceName?: string, hardwareHash?: string | null) {
  const id = randomUUID();
  const pin = randomPin();
  const pairingToken = randomSecret();
  const expires = new Date(Date.now() + 10 * 60_000).toISOString();
  await db.query(
    `INSERT INTO pairing_sessions (id, pin_lookup, pairing_token_hash, status, expires_at, device_name, hardware_hash)
     VALUES ($1, $2, $3, 'pending', $4, $5, $6)`,
    [id, pinLookup(pin), hashToken(pairingToken), expires, deviceName?.trim().slice(0, 80) || null, hardwareHash ?? null],
  );
  return { id, pin, pairingToken, expires_at: expires };
}

export async function pollPairing(db: PGlite, sessionId: string, pairingToken: string) {
  const r = await db.query<{
    status: string;
    pairing_token_hash: string;
    expires_at: string;
    tv_device_id: string | null;
    household_id: string | null;
    lan_capability_hash: string | null;
    lan_capability_plain: string | null;
  }>(`SELECT status, pairing_token_hash, expires_at, tv_device_id, household_id, lan_capability_hash, lan_capability_plain FROM pairing_sessions WHERE id = $1`, [sessionId]);
  const row = r.rows[0];
  if (!row) throw Object.assign(new Error("not_found"), { statusCode: 404 });
  if (row.pairing_token_hash !== hashToken(pairingToken)) {
    throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
  }
  if (row.status === "pending" && new Date(row.expires_at) < new Date()) {
    await db.query(`UPDATE pairing_sessions SET status = 'expired' WHERE id = $1`, [sessionId]);
    return { status: "expired" as const };
  }
  if (row.status === "paired" && row.lan_capability_plain) {
    await db.query(`UPDATE pairing_sessions SET lan_capability_plain = NULL WHERE id = $1`, [sessionId]);
    return { ...row, lan_capability: row.lan_capability_plain };
  }
  return { ...row, lan_capability: undefined };
}

export async function claimPin(
  db: PGlite,
  householdId: string,
  pin: string,
  tvDisplayName: string,
) {
  checkPinRate(householdId);
  const lookup = pinLookup(pin);
  const r = await db.query<{ id: string; status: string; expires_at: string; device_name: string | null; hardware_hash: string | null }>(
    `SELECT id, status, expires_at, device_name, hardware_hash FROM pairing_sessions WHERE pin_lookup = $1 AND status = 'pending'`,
    [lookup],
  );
  const row = r.rows[0];
  if (!row || new Date(row.expires_at) < new Date()) {
    recordPinFail(householdId);
    throw Object.assign(new Error(row ? "pin_expired" : "invalid_pin"), { statusCode: 400 });
  }
  clearPinFail(householdId);
  const deviceId = randomUUID();
  const lanCapability = randomSecret();
  await db.query(
    `INSERT INTO devices (id, household_id, kind, display_name, secret_hash, hardware_hash)
     VALUES ($1, $2, 'tv', $3, $4, $5)`,
    [deviceId, householdId, (tvDisplayName && tvDisplayName !== "TV" ? tvDisplayName : row.device_name) || "TV", hashToken(lanCapability), row.hardware_hash],
  );
  let replacedDeviceIds: string[] = [];
  if (row.hardware_hash) {
    const replaced = await db.query<{ id: string }>(
      `UPDATE devices SET revoked_at = NOW(), revoked_reason = 'replaced'
        WHERE household_id = $1 AND kind = 'tv' AND hardware_hash = $2 AND id <> $3 AND revoked_at IS NULL
        RETURNING id`,
      [householdId, row.hardware_hash, deviceId],
    );
    replacedDeviceIds = replaced.rows.map((r) => r.id);
  }
  await db.query(
    `UPDATE pairing_sessions SET status = 'paired', household_id = $1, tv_device_id = $2,
     lan_capability_hash = $3, lan_capability_plain = $4 WHERE id = $5`,
    [householdId, deviceId, hashToken(lanCapability), lanCapability, row.id],
  );
  return { pairing_session_id: row.id, device_id: deviceId, lan_capability: lanCapability, replacedDeviceIds };
}
