import type { PGlite } from "@electric-sql/pglite";
import type { PurgeRegistry } from "../plugins.ts";

/**
 * Core retention rules for short-lived rows:
 * - Telegram login links and sealed TV passwords: cleared once expired or resolved; row deleted 1 day later.
 * - Setup codes, phone join requests, rate-limit windows, pairing sessions, private-playback grants, profile switch requests: 1 day after expiry.
 * - Sign-in sessions: 7 days after expiry or revocation. TV commands: 7 days after expiry.
 * - Ended Telegram TV sessions: 30 days.
 */
export type PurgeStep = [table: string, sql: string];

export const CORE_PURGE_STEPS: PurgeStep[] = [
  ["telegram_tv_logins", `UPDATE telegram_tv_logins SET login_link = NULL
     WHERE login_link IS NOT NULL AND (expires_at < NOW() OR resolved_at IS NOT NULL)`],
  ["telegram_phone_logins", `UPDATE telegram_phone_logins SET login_link = NULL
     WHERE login_link IS NOT NULL AND (expires_at < NOW() OR resolved_at IS NOT NULL)`],
  ["telegram_tv_password_requests", `UPDATE telegram_tv_password_requests SET sealed = NULL
     WHERE sealed IS NOT NULL AND (expires_at < NOW() OR resolved_at IS NOT NULL)`],
  ["telegram_tv_logins", `DELETE FROM telegram_tv_logins WHERE expires_at < NOW() - INTERVAL '1 day'`],
  ["telegram_phone_logins", `DELETE FROM telegram_phone_logins WHERE expires_at < NOW() - INTERVAL '1 day'`],
  ["telegram_tv_password_requests", `DELETE FROM telegram_tv_password_requests WHERE expires_at < NOW() - INTERVAL '1 day'`],
  ["setup_codes", `DELETE FROM setup_codes WHERE expires_at < NOW() - INTERVAL '1 day'`],
  ["phone_join_requests", `DELETE FROM phone_join_requests WHERE expires_at < NOW() - INTERVAL '1 hour'`],
  ["auth_rate_limits", `DELETE FROM auth_rate_limits WHERE window_start < NOW() - INTERVAL '1 day'`],
  ["pairing_sessions", `DELETE FROM pairing_sessions WHERE expires_at < NOW() - INTERVAL '1 day'`],
  ["private_playback_grants", `DELETE FROM private_playback_grants WHERE expires_at < NOW() - INTERVAL '1 day'`],
  ["profile_switch_requests", `DELETE FROM profile_switch_requests WHERE expires_at < NOW() - INTERVAL '1 day'`],
  ["sessions", `DELETE FROM sessions
     WHERE expires_at < NOW() - INTERVAL '7 days' OR revoked_at < NOW() - INTERVAL '7 days'`],
  ["tv_commands", `DELETE FROM tv_commands
     WHERE COALESCE(expires_at, created_at + INTERVAL '1 day') < NOW() - INTERVAL '7 days'`],
  ["telegram_tv_sessions", `DELETE FROM telegram_tv_sessions WHERE terminated_at < NOW() - INTERVAL '30 days'`],
];

const extraSteps: Array<[table: string, sql: string]> = [];

export function registerPurgeStep(table: string, sql: string) {
  if (!extraSteps.some(([t, s]) => t === table && s === sql)) {
    extraSteps.push([table, sql]);
  }
}

export function createPurgeRegistry(steps: Array<[table: string, sql: string]> = extraSteps): PurgeRegistry {
  return {
    register(table: string, sql: string) {
      if (!steps.some(([t, s]) => t === table && s === sql)) {
        steps.push([table, sql]);
      }
    },
  };
}

/** One purge pass. Returns how many rows each table lost or had cleared; a failing step is logged and skipped. */
export async function purgeExpired(
  db: PGlite,
  additionalSteps: Array<[table: string, sql: string]> = extraSteps,
): Promise<Record<string, number>> {
  const changed: Record<string, number> = {};
  for (const [table, sql] of [...CORE_PURGE_STEPS, ...additionalSteps]) {
    try {
      const result = await db.query(sql);
      changed[table] = (changed[table] ?? 0) + (result.affectedRows ?? 0);
    } catch (error) {
      console.warn(JSON.stringify({ scope: "purge", event: "step_failed", table, message: String(error) }));
    }
  }
  return changed;
}

const HOUR_MS = 60 * 60 * 1000;

/** Runs [purgeExpired] now and then every hour. Returns a function that stops it. */
export function schedulePurge(
  db: PGlite,
  everyMs = HOUR_MS,
  additionalSteps: Array<[table: string, sql: string]> = extraSteps,
): () => void {
  const run = () => {
    void purgeExpired(db, additionalSteps).then((changed) => {
      const total = Object.values(changed).reduce((a, b) => a + b, 0);
      if (total > 0) console.log(JSON.stringify({ scope: "purge", event: "done", changed }));
    });
  };
  run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
