import type { FastifyInstance } from "fastify";
import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "./authorize.ts";

const PENDING_SECONDS = 120;

const forbidden = () => Object.assign(new Error("forbidden"), { statusCode: 403 });

export async function isSharedTv(db: PGlite, tvDeviceId: string): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM devices d
       JOIN devices o ON o.hardware_hash = d.hardware_hash AND o.household_id <> d.household_id
      WHERE d.id = $1 AND d.hardware_hash IS NOT NULL AND o.kind = 'tv' AND o.revoked_at IS NULL
      LIMIT 1`,
    [tvDeviceId],
  );
  return r.rows.length > 0;
}

export function registerProfileLockRoutes(app: FastifyInstance, db: PGlite) {
  app.post("/api/profiles/switch-requests", async (req, reply) => {
    const auth = await requireAuth(req);
    const body = z
      .object({
        profileId: z.string().uuid(),
        deviceName: z.string().trim().max(100).optional(),
      })
      .parse(req.body);
    const profile = await db.query<{ name: string; profile_lock: boolean; pin_set: boolean }>(
      `SELECT p.name, h.profile_lock, (p.pin_hash IS NOT NULL) AS pin_set
       FROM profiles p JOIN households h ON h.id = p.household_id
       WHERE p.id = $1 AND p.household_id = $2`,
      [body.profileId, auth.household_id],
    );
    const row = profile.rows[0];
    if (!row) throw Object.assign(new Error("profile_not_found"), { statusCode: 404 });
    const tvDeviceId = auth.scope === "tv" ? auth.device_id : null;
    const shared = tvDeviceId ? await isSharedTv(db, tvDeviceId) : false;
    const status = tvDeviceId && (row.profile_lock || shared) && !row.pin_set ? "pending" : "approved";
    if (tvDeviceId) {
      await db.query(
        `UPDATE profile_switch_requests SET status = 'expired', resolved_at = NOW()
         WHERE household_id = $1 AND tv_device_id = $2 AND status = 'pending'`,
        [auth.household_id, tvDeviceId],
      );
    }
    const id = randomUUID();
    await db.query(
      `INSERT INTO profile_switch_requests
         (id, household_id, profile_id, device_name, tv_device_id, status, expires_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() + make_interval(secs => $7),
         CASE WHEN $6 = 'approved' THEN NOW() END)`,
      [id, auth.household_id, body.profileId, body.deviceName ?? null, tvDeviceId, status, PENDING_SECONDS],
    );
    return reply.code(202).send({ requestId: id, status, profileName: row.name, shared });
  });

  app.get("/api/profiles/switch-requests/pending", async (req) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "phone") throw forbidden();
    const r = await db.query<{ id: string; profile_id: string; profile_name: string; tv_name: string | null; expires_at: string; tv_device_id: string | null }>(
      `SELECT r.id, r.profile_id, p.name AS profile_name, r.tv_device_id,
              COALESCE(NULLIF(d.display_name, ''), r.device_name) AS tv_name, r.expires_at
       FROM profile_switch_requests r
       JOIN profiles p ON p.id = r.profile_id
       LEFT JOIN devices d ON d.id = r.tv_device_id
       WHERE r.household_id = $1 AND r.status = 'pending' AND r.expires_at > NOW()
       ORDER BY r.created_at`,
      [auth.household_id],
    );
    const items = [];
    for (const row of r.rows) {
      items.push({
        request_id: row.id,
        profile_id: row.profile_id,
        profile_name: row.profile_name,
        tv_name: row.tv_name,
        expires_at: row.expires_at,
        shared_tv: row.tv_device_id ? await isSharedTv(db, row.tv_device_id) : false,
      });
    }
    return { items };
  });

  app.get("/api/profiles/switch-requests/:requestId", async (req) => {
    const auth = await requireAuth(req);
    const { requestId } = z.object({ requestId: z.string().uuid() }).parse(req.params);
    const r = await db.query<{ id: string; status: string; profile_name: string; expires_at: string }>(
      `SELECT r.id, r.expires_at, p.name AS profile_name,
              CASE WHEN r.status = 'pending' AND r.expires_at <= NOW() THEN 'expired' ELSE r.status END AS status
       FROM profile_switch_requests r
       JOIN profiles p ON p.id = r.profile_id
       WHERE r.id = $1 AND r.household_id = $2`,
      [requestId, auth.household_id],
    );
    const row = r.rows[0];
    if (!row) throw Object.assign(new Error("switch_request_not_found"), { statusCode: 404 });
    return { requestId: row.id, status: row.status, expiresAt: row.expires_at, profileName: row.profile_name };
  });

  async function answer(req: Parameters<typeof requireAuth>[0], status: "approved" | "denied") {
    const auth = await requireAuth(req);
    if (auth.scope !== "phone") throw forbidden();
    const { requestId } = z.object({ requestId: z.string().uuid() }).parse(req.params);
    const r = await db.query(
      `UPDATE profile_switch_requests SET status = $3, resolved_at = NOW()
       WHERE id = $1 AND household_id = $2 AND status = 'pending' AND expires_at > NOW()
       RETURNING id`,
      [requestId, auth.household_id, status],
    );
    if (!r.rows[0]) throw Object.assign(new Error("switch_request_not_pending"), { statusCode: 409 });
    return { ok: true, status };
  }

  app.post("/api/profiles/switch-requests/:requestId/approve", (req) => answer(req, "approved"));
  app.post("/api/profiles/switch-requests/:requestId/deny", (req) => answer(req, "denied"));

  app.post("/api/profiles/switch-requests/:requestId/cancel", async (req) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "tv") throw forbidden();
    const { requestId } = z.object({ requestId: z.string().uuid() }).parse(req.params);
    await db.query(
      `UPDATE profile_switch_requests SET status = 'expired', resolved_at = NOW()
       WHERE id = $1 AND household_id = $2 AND tv_device_id = $3 AND status = 'pending'`,
      [requestId, auth.household_id, auth.device_id],
    );
    return { ok: true };
  });
}
