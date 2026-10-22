import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { requireAuth } from "./authorize.ts";
import type { TvClaims } from "../auth/jwt.ts";

type CommandRow = { id: string; command: string; payload: string | Record<string, unknown> | null; expires_at: Date | string };
const resultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("complete"), id: z.string().uuid() }),
  z.object({ type: z.literal("reject"), id: z.string().uuid(), reason: z.string().min(1).max(120) }),
]);
type Result = z.infer<typeof resultSchema>;
const wire = (row: CommandRow) => ({
  id: row.id, command: row.command,
  payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload ?? {},
  expires_at_ms: new Date(row.expires_at).getTime(),
  // Clients with a skewed clock anchor expiry on this instead of the absolute time.
  expires_in_ms: Math.max(0, new Date(row.expires_at).getTime() - Date.now()),
});

/** A TV that asked for commands over HTTP this recently still counts as on (it polls every few seconds). */
const POLLED_ONLINE_MS = 15_000;

/** Whether a TV can take a command now: its command socket is open, or it polled recently. */
export type TvPresence = (deviceId: string) => boolean;

export function registerCommandRoutes(app: FastifyInstance, db: PGlite): TvPresence {
  const sockets = new Map<string, { socket: WebSocket; pump: () => Promise<void> }>();
  const polledAt = new Map<string, number>();

  async function tvAuth(req: FastifyRequest): Promise<TvClaims> {
    const auth = await requireAuth(req);
    if (auth.scope !== "tv") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    // Check existence and revocation against this app's DB, including on an
    // already-open connection. The HTTP auth cache alone is insufficient here.
    const device = await db.query(
      "SELECT id FROM devices WHERE id = $1 AND household_id = $2 AND kind = 'tv' AND revoked_at IS NULL",
      [auth.device_id, auth.household_id],
    );
    if (!device.rows.length) throw Object.assign(new Error("device_revoked"), { statusCode: 401 });
    return auth;
  }

  async function expire(auth: TvClaims) {
    await db.query(
      `UPDATE tv_commands SET rejected_at = NOW(), rejection_reason = 'expired'
       WHERE household_id = $1 AND target_device_id = $2 AND expires_at <= NOW()
         AND completed_at IS NULL AND rejected_at IS NULL`,
      [auth.household_id, auth.device_id],
    );
  }

  async function claim(auth: TvClaims, reliable: boolean) {
    await expire(auth);
    // Both transports share this atomic lease. A lost socket send or HTTP
    // response becomes eligible again after three seconds.
    const rows = await db.query<CommandRow>(
      `UPDATE tv_commands SET claimed_at = COALESCE(claimed_at, NOW()),
          delivery_until = NOW() + INTERVAL '3 seconds'
       WHERE id IN (
         SELECT id FROM tv_commands WHERE household_id = $1 AND target_device_id = $2
           AND completed_at IS NULL AND rejected_at IS NULL AND expires_at > NOW()
           AND ${reliable ? "(delivery_until IS NULL OR delivery_until <= NOW())" : "claimed_at IS NULL"}
         ORDER BY created_at, id LIMIT 20
       ) RETURNING id, command, payload, expires_at, created_at`,
      [auth.household_id, auth.device_id],
    );
    // UPDATE RETURNING does not promise the selection order.
    return (rows.rows as (CommandRow & { created_at: Date | string })[])
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || a.id.localeCompare(b.id));
  }

  async function finish(auth: TvClaims, result: Result) {
    // First terminal result wins. Duplicate results return the stored outcome.
    // A late result can still describe an action executed before expiry: a
    // complete replaces the server's own "expired" rejection when the TV
    // received the command in time (the TV checks expiry before executing).
    await db.query(
      `UPDATE tv_commands SET
         completed_at = CASE WHEN $4 = 'complete' THEN NOW() ELSE NULL END,
         rejected_at = CASE WHEN $4 = 'reject' THEN NOW() ELSE NULL END,
         rejection_reason = $5
       WHERE id = $1 AND household_id = $2 AND target_device_id = $3
         AND claimed_at IS NOT NULL AND completed_at IS NULL
         AND (rejected_at IS NULL
           OR ($4 = 'complete' AND rejection_reason = 'expired' AND claimed_at < expires_at))`,
      [result.id, auth.household_id, auth.device_id, result.type, result.type === "reject" ? result.reason : null],
    );
    const stored = await db.query<{ completed_at: unknown; rejected_at: unknown; rejection_reason: string | null }>(
      `SELECT completed_at, rejected_at, rejection_reason FROM tv_commands
       WHERE id = $1 AND household_id = $2 AND target_device_id = $3 AND claimed_at IS NOT NULL`,
      [result.id, auth.household_id, auth.device_id],
    );
    const row = stored.rows[0];
    if (!row || (!row.completed_at && !row.rejected_at)) throw Object.assign(new Error("not_found"), { statusCode: 404 });
    return { type: "receipt", id: result.id, status: row.completed_at ? "completed" : "rejected", reason: row.rejection_reason };
  }

  // The workspace currently has two physical Fastify installations; keep the
  // plugin route adapter local instead of casting the app or requests to any.
  const socketRoute = app.get.bind(app) as unknown as (
    path: string,
    options: { websocket: true; preValidation: (req: FastifyRequest) => Promise<void> },
    handler: (socket: WebSocket, req: FastifyRequest) => void,
  ) => void;
  socketRoute("/api/control/commands/socket", {
    websocket: true,
    preValidation: async (req) => { await tvAuth(req); },
  }, (socket, req) => {
    let closed = false;
    let deviceId: string | undefined;
    let pumping = false;
    let pumpAgain = false;
    const authPromise = tvAuth(req);
    const pump = async () => {
      if (closed) return;
      if (pumping) { pumpAgain = true; return; }
      pumping = true;
      try {
        const auth = await authPromise;
        await tvAuth(req);
        do {
          pumpAgain = false;
          if (closed || socket.readyState !== socket.OPEN) return;
          for (const row of await claim(auth, true)) {
            if (closed || socket.readyState !== socket.OPEN) break;
            socket.send(JSON.stringify({ type: "command", command: wire(row) }));
          }
        } while (pumpAgain && !closed);
      } catch {
        socket.close(1011, "command_channel_unavailable");
      } finally { pumping = false; }
    };
    const timer = setInterval(() => { void pump(); }, 1_000);
    timer.unref();
    // Install listeners synchronously, before authentication/database awaits.
    socket.on("close", () => {
      closed = true;
      clearInterval(timer);
      if (deviceId && sockets.get(deviceId)?.socket === socket) sockets.delete(deviceId);
    });
    let messages = Promise.resolve();
    socket.on("message", (raw: Buffer) => {
      messages = messages.then(async () => {
        const parsed = resultSchema.safeParse(JSON.parse(raw.toString()));
        if (!parsed.success) { socket.close(1008, "invalid_result"); return; }
        const auth = await tvAuth(req);
        const receipt = await finish(auth, parsed.data);
        if (!closed && socket.readyState === socket.OPEN) socket.send(JSON.stringify(receipt));
        await pump();
      }).catch(() => { socket.close(1011, "result_not_recorded"); });
    });
    void authPromise.then(async (auth) => {
      if (closed) return;
      deviceId = auth.device_id;
      sockets.get(deviceId)?.socket.close(1000, "replaced");
      sockets.set(deviceId, { socket, pump });
      socket.send(JSON.stringify({ type: "ready" }));
      await pump();
    }).catch(() => socket.close(1008, "unauthorized"));
  });

  app.post("/api/control/commands", async (req, reply) => {
    const auth = await requireAuth(req);
    // Remote control is issued by the account holder's phone, never by a TV.
    if (auth.scope !== "phone") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    const body = z.object({
      command: z.string().min(1).max(32),
      payload: z.record(z.string(), z.unknown()).optional(),
      target_device_id: z.string().uuid().optional(),
      // Client-generated so a retried send cannot create a second command.
      id: z.string().uuid().optional(),
    }).parse(req.body);
    if (body.id && !body.target_device_id) throw Object.assign(new Error("id_requires_target_device"), { statusCode: 400 });
    const devices = await db.query<{ id: string }>(
      `SELECT id FROM devices WHERE household_id = $1 AND kind = 'tv' AND revoked_at IS NULL
       ${body.target_device_id ? "AND id = $2" : ""}`,
      body.target_device_id ? [auth.household_id, body.target_device_id] : [auth.household_id],
    );
    if (body.target_device_id && !devices.rows.length) throw Object.assign(new Error("unknown_target_device"), { statusCode: 400 });
    // Only a deliberate title start gets minutes; any other control is stale after 30 s.
    const ttl = body.command === "play" && typeof body.payload?.videoId === "string" ? 300 : 30;
    const ids: string[] = [];
    for (const target of devices.rows.length ? devices.rows.map(d => d.id) : [null]) {
      const id = body.id ?? randomUUID();
      const inserted = await db.query(
        `INSERT INTO tv_commands (id, household_id, command, payload, target_device_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, NOW() + $6 * INTERVAL '1 second')
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id, auth.household_id, body.command, JSON.stringify(body.payload ?? {}), target, ttl],
      );
      if (!inserted.rows.length) {
        // Same household, target, command and payload is a duplicate send; anything
        // else (including another household's ID) is a conflict.
        const existing = await db.query<{ command: string; payload: string | Record<string, unknown> | null; target_device_id: string | null }>(
          "SELECT command, payload, target_device_id FROM tv_commands WHERE id = $1 AND household_id = $2", [id, auth.household_id]);
        const row = existing.rows[0];
        const stored = typeof row?.payload === "string" ? JSON.parse(row.payload) : row?.payload ?? {};
        if (!row || row.command !== body.command || row.target_device_id !== target || !isDeepStrictEqual(stored, body.payload ?? {}))
          throw Object.assign(new Error("command_id_conflict"), { statusCode: 409 });
        return reply.code(200).send({ id });
      }
      ids.push(id);
      if (target) await sockets.get(target)?.pump();
    }
    return reply.code(201).send({ id: ids[0] });
  });

  app.get("/api/control/commands/:commandId", async (req) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "phone") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    const commandId = z.string().uuid().parse((req.params as { commandId: string }).commandId);
    await db.query(
      `UPDATE tv_commands SET rejected_at = NOW(), rejection_reason = 'expired'
       WHERE id = $1 AND household_id = $2 AND expires_at <= NOW()
         AND completed_at IS NULL AND rejected_at IS NULL`,
      [commandId, auth.household_id],
    );
    const found = await db.query<{ id: string; command: string; target_device_id: string | null; expires_at: Date | string;
      claimed_at: unknown; completed_at: unknown; rejected_at: unknown; rejection_reason: string | null }>(
      `SELECT id, command, target_device_id, expires_at, claimed_at, completed_at, rejected_at, rejection_reason
       FROM tv_commands WHERE id = $1 AND household_id = $2`, [commandId, auth.household_id]);
    const row = found.rows[0];
    if (!row) throw Object.assign(new Error("not_found"), { statusCode: 404 });
    const status = row.completed_at ? "completed" : row.rejected_at ? "rejected" : row.claimed_at ? "delivered" : "pending";
    const expiresAtMs = new Date(row.expires_at).getTime();
    return { id: row.id, command: row.command, target_device_id: row.target_device_id, status,
      reason: status === "rejected" ? row.rejection_reason : null, expires_at_ms: expiresAtMs,
      // A phone with a skewed clock anchors its wait on this instead of the absolute time.
      expires_in_ms: Math.max(0, expiresAtMs - Date.now()) };
  });

  app.get("/api/control/commands", async (req) => {
    const auth = await requireAuth(req);
    if (auth.scope === "tv") {
      await tvAuth(req);
      // Legacy clients lack deduplication. Only updated clients request leases.
      const reliable = (req.query as { delivery?: string }).delivery === "ack";
      polledAt.set(auth.device_id, Date.now());
      return { commands: (await claim(auth, reliable)).map(wire) };
    }
    const rows = await db.query<CommandRow>(
      `UPDATE tv_commands SET claimed_at = NOW() WHERE id IN (
         SELECT id FROM tv_commands WHERE household_id = $1 AND target_device_id IS NULL
         AND claimed_at IS NULL AND expires_at > NOW() ORDER BY created_at LIMIT 20
       ) RETURNING id, command, payload, expires_at`, [auth.household_id],
    );
    return { commands: rows.rows.map(wire) };
  });

  // TVs already installed send this with content-type application/json and no body, which Fastify rejects with a 400.
  // The route carries no body, so its own scope accepts an empty one; every other route keeps the strict JSON parser.
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
      if (body === "") return done(null, {});
      try { done(null, JSON.parse(body as string)); } catch { done(Object.assign(new Error("invalid_json"), { statusCode: 400 })); }
    });
    scope.post("/api/control/commands/:commandId/complete", async (req, reply) => {
      const auth = await tvAuth(req);
      await finish(auth, { type: "complete", id: z.string().uuid().parse((req.params as { commandId: string }).commandId) });
      return reply.code(204).send();
    });
  });
  app.post("/api/control/commands/:commandId/reject", async (req, reply) => {
    const auth = await tvAuth(req);
    const { reason } = z.object({ reason: z.string().min(1).max(120) }).parse(req.body);
    await finish(auth, { type: "reject", id: z.string().uuid().parse((req.params as { commandId: string }).commandId), reason });
    return reply.code(204).send();
  });

  const online: TvPresence = (deviceId) =>
    sockets.has(deviceId) || Date.now() - (polledAt.get(deviceId) ?? 0) < POLLED_ONLINE_MS;

  // CAB-57: what each TV's player is doing, so the phone follows a title that ends, stops or is paused on the TV.
  // Kept in memory only: after a restart a TV reports again on its next change, and until then the phone sees
  // "unknown" and keeps what it had.
  const playbackSchema = z.object({
    state: z.enum(["playing", "paused", "stopped"]),
    video_id: z.string().min(1).max(200).nullable().optional(),
    origin_id: z.string().min(1).max(200).nullable().optional(),
    position_ms: z.number().int().min(0).max(1e10).optional(),
    // Increases with every report from one TV, so a report that arrives late cannot replace a newer one.
    seq: z.number().int().min(0),
  });
  const playback = new Map<string, z.infer<typeof playbackSchema> & { household_id: string; updated_at_ms: number }>();

  app.put("/api/control/playback", async (req, reply) => {
    const auth = await tvAuth(req);
    const report = playbackSchema.parse(req.body);
    const current = playback.get(auth.device_id);
    if (!current || current.household_id !== auth.household_id || report.seq > current.seq)
      playback.set(auth.device_id, { ...report, household_id: auth.household_id, updated_at_ms: Date.now() });
    return reply.code(204).send();
  });

  app.get("/api/control/playback/:deviceId", async (req) => {
    const auth = await requireAuth(req);
    if (auth.scope !== "phone") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    const deviceId = z.string().uuid().parse((req.params as { deviceId: string }).deviceId);
    const device = await db.query(
      "SELECT id FROM devices WHERE id = $1 AND household_id = $2 AND kind = 'tv' AND revoked_at IS NULL",
      [deviceId, auth.household_id],
    );
    if (!device.rows.length) throw Object.assign(new Error("not_found"), { statusCode: 404 });
    const report = playback.get(deviceId);
    const known = report?.household_id === auth.household_id ? report : undefined;
    return {
      device_id: deviceId,
      online: online(deviceId),
      state: known?.state ?? "unknown",
      video_id: known?.video_id ?? null,
      origin_id: known?.origin_id ?? null,
      position_ms: known?.position_ms ?? null,
      // Relative, so a phone with a skewed clock can still tell how fresh the report is.
      age_ms: known ? Date.now() - known.updated_at_ms : null,
    };
  });

  return online;
}
