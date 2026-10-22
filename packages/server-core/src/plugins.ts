import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PGlite } from "@electric-sql/pglite";
import type { PhoneClaims, TvClaims } from "./auth/jwt.ts";

export interface ServerFeatures {
  artwork: boolean;
  ai_title_resolution: boolean;
  subtitles: boolean;
  relay: boolean;
  web_import: boolean;
  cloud_storage: boolean;
  telegram: boolean;
  lan_playback: boolean;
  profile_lock: boolean;
}

export type ServerAuthDescriptor =
  | { mode: "device" }
  | {
      mode: "account";
      google: { client_id: string } | null;
      apple?: { client_id: string } | null;
      email_code: boolean;
    };

export interface ServerLegalDescriptor {
  terms: { version: string; url: string; acceptance_required_from: string };
  privacy: { version: string; url: string };
}

export interface ServerCapabilitiesResponse {
  api_version: 1;
  edition: "community" | "hosted";
  server_version: string;
  auth: ServerAuthDescriptor;
  features: ServerFeatures;
  legal: ServerLegalDescriptor | null;
}

export type AvatarRequestLike = { headers: Record<string, string | string[] | undefined> };

export type CatalogItemRow = Record<string, unknown> & {
  id: string;
  title: string;
  original_display_hint: string | null;
  duration_seconds: number | null;
  poster_url: string | null;
  year: number | null;
  overview: string | null;
  director: string | null;
  backdrop_url: string | null;
  media_type: string;
  series_identity: string | null;
  season_number: number | null;
  episode_number: number | null;
  episode_title: string | null;
  genres: string[];
  match_status: string;
  created_at: string;
  user_metadata_fields: string[];
  metadata_revision: number;
  sources: Array<Record<string, unknown>>;
  collections: Array<{ id: string; name: string }>;
  progress: Record<string, unknown> | null;
  in_my_list: boolean;
};

export type CatalogDecoratorContext = {
  db: PGlite;
  householdId: string;
  profileId?: string;
  requestBase: string;
  items: CatalogItemRow[];
};

export type CatalogFieldDecorator = (ctx: CatalogDecoratorContext) => Promise<void> | void;

export type PlaybackResolveContext = {
  db: PGlite;
  householdId: string;
  tvDeviceId: string;
  mediaItemId: string;
  attemptId?: string;
  authorizePrivate: (isPrivate: boolean) => Promise<void>;
};

export type PlaybackResolved = {
  status: "ready";
  url: string;
  headers: Record<string, string>;
  mime_type: string | null;
  expiresAt?: string;
  title: string;
  poster_url: string | null;
  source_id?: string;
};

export type PlaybackResolver = (ctx: PlaybackResolveContext) => Promise<PlaybackResolved | null>;

export interface CoreHooks {
  onActivity: Array<(db: PGlite, householdId: string, userId?: string) => Promise<void> | void>;
  onTvPlayback: Array<
    (
      db: PGlite,
      householdId: string,
      deviceId: string,
      profileId: string,
      itemId: string,
      body: { position_seconds: number; state: string; client_updated_at?: string },
    ) => Promise<void> | void
  >;
  afterTelegramItemImported: Array<
    (db: PGlite, householdId: string, stableSourceKey: string) => Promise<void> | void
  >;
  onCatalogItemWrite: Array<
    (db: PGlite, householdId: string, itemId: string, posterUrl?: string, isUpdate?: boolean) => Promise<void> | void
  >;
  profileAvatar?: (
    db: PGlite,
    profileId: string,
    displayName: string,
    req?: AvatarRequestLike,
    requestBase?: string,
  ) => Promise<string | null>;
  legalStatus?: (
    db: PGlite,
    userId: string,
  ) => Promise<{ acceptance_required: boolean; terms_version: string; privacy_version: string } | undefined>;
  onPhoneHardwareSeen: Array<(db: PGlite, hash: string | null, householdId: string) => Promise<void> | void>;
  catalogDecorators: CatalogFieldDecorator[];
  playbackResolvers: PlaybackResolver[];
  errorMappers: Array<(err: unknown) => { statusCode: number; body: Record<string, unknown> } | null>;
  authDescriptor?: () => ServerAuthDescriptor;
  legalDescriptor?: () => ServerLegalDescriptor | null;
}

export interface PurgeRegistry {
  register(table: string, sql: string): void;
}

export interface PluginContext {
  app: FastifyInstance;
  db: PGlite;
  auth: {
    require(req: FastifyRequest): Promise<PhoneClaims | TvClaims>;
  };
  hooks: CoreHooks;
  purge: PurgeRegistry;
  requestBase(req: AvatarRequestLike): string;
}

export interface CablegramPlugin {
  name: string;
  migrations?: { dir: string };
  capabilities?: Partial<ServerFeatures>;
  register(ctx: PluginContext): void | Promise<void>;
  start?(ctx: PluginContext): Promise<void>;
  stop?(): Promise<void>;
}
