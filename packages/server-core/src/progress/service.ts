import type { PGlite } from "@electric-sql/pglite";

export function progressTime(clientUpdatedAt: string | undefined, now: number = Date.now()): string {
  const at = clientUpdatedAt === undefined ? Number.NaN : Date.parse(clientUpdatedAt);
  return new Date(Number.isFinite(at) && at < now ? at : now).toISOString();
}

export async function upsertProgress(
  db: PGlite,
  profileId: string,
  itemId: string,
  body: {
    position_seconds: number;
    duration_seconds?: number;
    state: string;
    client_updated_at?: string;
  },
) {
  const updated = progressTime(body.client_updated_at);
  await db.query(
    `INSERT INTO watch_progress (profile_id, media_item_id, position_seconds, duration_seconds, state, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (profile_id, media_item_id) DO UPDATE SET
       position_seconds = EXCLUDED.position_seconds,
       duration_seconds = EXCLUDED.duration_seconds,
       state = EXCLUDED.state,
       updated_at = EXCLUDED.updated_at
     WHERE watch_progress.updated_at <= EXCLUDED.updated_at`,
    [
      profileId,
      itemId,
      body.position_seconds,
      body.duration_seconds ?? null,
      body.state,
      updated,
    ],
  );
}
