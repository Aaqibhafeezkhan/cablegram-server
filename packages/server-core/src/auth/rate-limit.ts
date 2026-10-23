import { createHmac } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { coreConfig } from "../config.ts";

/** A rate-limit key that names what is counted without storing the raw identifier or IP address itself. */
export function limitKey(kind: string, value: string): string {
  return `${kind}:${createHmac("sha256", coreConfig.pinPepper).update(`rate:${kind}:${value}`).digest("hex").slice(0, 32)}`;
}

/**
 * Counts one hit in a fixed window kept in the database, so a restart doesn't reset it. Returns the seconds to wait
 * when the window already holds [limit] hits; the refused hit isn't counted.
 */
export async function hit(db: PGlite, key: string, limit: number, windowSeconds: number): Promise<{ retryAfter: number } | null> {
  const windowMs = windowSeconds * 1000;
  const start = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const r = await db.query<{ hits: number }>(
    `INSERT INTO auth_rate_limits (key, window_start, hits) VALUES ($1, $2, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET hits = auth_rate_limits.hits + 1
       WHERE auth_rate_limits.hits < $3
     RETURNING hits`,
    [key, start.toISOString(), limit],
  );
  if (r.rows.length > 0) return null;
  return { retryAfter: Math.max(1, Math.ceil((start.getTime() + windowMs - Date.now()) / 1000)) };
}

/** Throws 429 with `retry_after` when any of the limits is reached. */
export async function enforce(db: PGlite, limits: { key: string; limit: number; windowSeconds: number }[], error = "rate_limited") {
  for (const l of limits) {
    const refused = await hit(db, l.key, l.limit, l.windowSeconds);
    if (refused) throw Object.assign(new Error(error), { statusCode: 429, extra: { retry_after: refused.retryAfter } });
  }
}

type RequestLike = { headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } };

/**
 * The caller's address. A reverse proxy sets X-Real-IP / X-Forwarded-For, so they are trusted on connections from loopback,
 * or from any peer when TRUST_PROXY=true (the server is then reachable only through the proxy, as in the Compose example).
 * Otherwise anyone could write the header themselves.
 */
export function clientIp(req: RequestLike): string {
  const remote = req.socket.remoteAddress ?? "unknown";
  const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (!loopback && !coreConfig.trustProxy) return remote;
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.trim()) return real.trim();
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || remote;
}
