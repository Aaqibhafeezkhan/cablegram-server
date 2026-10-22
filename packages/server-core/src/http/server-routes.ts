import type { FastifyInstance } from "fastify";
import type {
  CablegramPlugin,
  CoreHooks,
  ServerCapabilitiesResponse,
  ServerFeatures,
} from "../plugins.ts";

export interface ServerRouteOptions {
  edition?: "community" | "hosted";
  serverVersion?: string;
  plugins: CablegramPlugin[];
  hooks: CoreHooks;
}

export function computeServerFeatures(plugins: CablegramPlugin[]): ServerFeatures {
  const merged: ServerFeatures = {
    artwork: false,
    ai_title_resolution: false,
    subtitles: false,
    relay: false,
    web_import: false,
    cloud_storage: false,
    telegram: true,
    lan_playback: true,
    profile_lock: true,
  };
  for (const plugin of plugins) {
    if (!plugin.capabilities) continue;
    for (const [k, v] of Object.entries(plugin.capabilities)) {
      if (typeof v === "boolean" && k in merged) {
        (merged as unknown as Record<string, boolean>)[k] = v;
      }
    }
  }
  return merged;
}

export function registerServerRoutes(app: FastifyInstance, options: ServerRouteOptions) {
  const edition = options.edition ?? (options.plugins.length > 0 ? "hosted" : "community");
  const serverVersion = options.serverVersion ?? "0.1.0";

  app.get("/api/server", async (_req, reply): Promise<ServerCapabilitiesResponse> => {
    reply.header("Cache-Control", "no-store");
    const features = computeServerFeatures(options.plugins);
    const auth = options.hooks.authDescriptor
      ? options.hooks.authDescriptor()
      : { mode: "device" as const };
    const legal = options.hooks.legalDescriptor ? options.hooks.legalDescriptor() : null;
    return {
      api_version: 1,
      edition,
      server_version: serverVersion,
      auth,
      features,
      legal,
    };
  });

  const registeredNames = new Set(options.plugins.map((p) => p.name));
  const unavailable = async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.code(410).send({ error: "feature_unavailable" });

  if (!registeredNames.has("ai-title")) {
    app.post("/api/library/resolve-title", unavailable);
    app.post("/api/library/enrich", unavailable);
    app.get("/api/catalog/sources/telegram/hints", unavailable);
    app.put("/api/catalog/sources/telegram/hints", unavailable);
  }

  if (!registeredNames.has("artwork")) {
    app.get("/api/catalog/items/:itemId/poster", unavailable);
    app.put("/api/catalog/items/:itemId/poster", unavailable);
    app.post("/api/catalog/items/:itemId/poster/from-url", unavailable);
    app.delete("/api/catalog/items/:itemId/poster", unavailable);
  }

  if (!registeredNames.has("web-import")) {
    app.post("/api/library/web-imports", unavailable);
    app.get("/api/library/jobs/:jobId", unavailable);
    app.post("/api/library/items/:itemId/storage-transfers", unavailable);
  }

  if (!registeredNames.has("cloud-storage")) {
    app.get("/api/storage/connections", unavailable);
    app.delete("/api/storage/connections/:id", unavailable);
  }
}
