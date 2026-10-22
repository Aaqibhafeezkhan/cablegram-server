import type { FastifyInstance } from "fastify";

/** `WEB_APP_ORIGINS`: comma-separated origins (scheme + host). */
export function parseWebOrigins(value: string | undefined): string[] {
  return (value ?? "").split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean);
}

/**
 * Lets configured browser clients call this API from their own origin.
 * Only the listed origins, matched exactly, and never "*".
 */
export function registerCors(app: FastifyInstance, origins: string[]) {
  if (!origins.length) return;
  const allowed = new Set(origins);
  app.addHook("onRequest", async (req, reply) => {
    reply.header("vary", "Origin");
    const origin = req.headers.origin;
    if (!origin || !allowed.has(origin)) return;
    reply.header("access-control-allow-origin", origin);
    reply.header("access-control-expose-headers", "content-range, accept-ranges, content-length");
    if (req.method === "OPTIONS" && req.headers["access-control-request-method"]) {
      return reply
        .header("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE")
        .header("access-control-allow-headers", "authorization, content-type")
        .header("access-control-max-age", "600")
        .code(204)
        .send();
    }
  });
}
