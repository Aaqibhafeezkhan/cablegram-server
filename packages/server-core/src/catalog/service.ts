import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { defaultTitle } from "./match.ts";
import type { CatalogItemRow } from "../plugins.ts";

export async function listCatalog(
  db: PGlite,
  householdId: string,
  profileId?: string,
  options: {
    search?: string;
    media_type?: string;
    shelf?: string;
    collection_id?: string;
  } = {},
): Promise<CatalogItemRow[]> {
  const params: unknown[] = [householdId];
  const filters = ["i.household_id = $1", "i.hidden_at IS NULL"];
  let profileParam: string | undefined;
  if (options.shelf === "continue_watching") {
    if (!profileId) return [];
    params.push(profileId);
    profileParam = `$${params.length}`;
    filters.push(`EXISTS (SELECT 1 FROM watch_progress wp WHERE wp.media_item_id = i.id AND wp.profile_id = ${profileParam} AND wp.state <> 'completed' AND wp.position_seconds > 0)`);
  }
  if (options.search?.trim()) {
    params.push(`%${options.search.trim()}%`);
    const p = `$${params.length}`;
    filters.push(`(i.title ILIKE ${p} OR i.original_display_hint ILIKE ${p} OR CAST(i.year AS TEXT) ILIKE ${p} OR array_to_string(i.genres, ' ') ILIKE ${p})`);
  }
  if (options.media_type && ["movie", "tv"].includes(options.media_type)) {
    params.push(options.media_type);
    filters.push(`i.media_type = $${params.length}`);
  }
  if (options.collection_id) {
    params.push(options.collection_id);
    filters.push(`EXISTS (SELECT 1 FROM collection_members cm WHERE cm.media_item_id = i.id AND cm.collection_id = $${params.length})`);
  }
  const items = await db.query<{
    id: string;
    title: string;
    original_display_hint: string | null;
    duration_seconds: number | null;
    year: number | null;
    overview: string | null;
    director: string | null;
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
  }>(
    `SELECT
        i.id, i.title, i.original_display_hint, ROUND(i.duration_seconds) AS duration_seconds,
        i.year, i.description AS overview, i.director,
        i.media_type, i.series_identity, i.season_number, i.episode_number,
        i.episode_title, i.genres, i.match_status, i.created_at, i.user_metadata_fields, i.metadata_revision
       FROM media_items i
       WHERE ${filters.join(" AND ")}
         AND EXISTS (SELECT 1 FROM media_sources s WHERE s.media_item_id = i.id AND s.archive_state <> 'archived'
                       AND (s.kind <> 'telegram' OR EXISTS (SELECT 1 FROM telegram_links l WHERE l.household_id = i.household_id))
                       AND (s.kind <> 'telegram' OR s.availability <> 'unavailable')
                       AND (s.kind <> 'own_cloud' OR s.availability = 'available'))
      ORDER BY CASE WHEN $${params.length + 1} = 'recently_added' THEN i.created_at END DESC NULLS LAST,
        i.updated_at DESC, i.created_at DESC`,
    [...params, options.shelf ?? ""],
  );
  if (items.rows.length === 0) return [];
  const ids = items.rows.map((item) => item.id);
  const sources = await db.query<{ media_item_id: string } & Record<string, unknown>>(
    `SELECT id, media_item_id, kind, origin_filename, origin_identity, serving_device_id, availability,
            stable_source_key, phone_location, source_fingerprint, archive_state,
            private, last_seen_at, playback_mime, bytes_total
     FROM media_sources WHERE media_item_id = ANY($1::uuid[])`,
    [ids],
  );
  const progress = profileId
    ? await db.query<{ media_item_id: string } & Record<string, unknown>>(
      `SELECT media_item_id, ROUND(position_seconds) AS position_seconds, ROUND(duration_seconds) AS duration_seconds, state, updated_at FROM watch_progress
       WHERE profile_id = $1 AND media_item_id = ANY($2::uuid[])`,
      [profileId, ids],
    )
    : { rows: [] };
  const myList = new Set(profileId
    ? (await db.query<{ media_item_id: string }>(
      `SELECT media_item_id FROM profile_my_list WHERE profile_id = $1 AND media_item_id = ANY($2::uuid[])`,
      [profileId, ids],
    )).rows.map((row) => row.media_item_id)
    : []);
  const collections = await db.query<{ media_item_id: string; id: string; name: string }>(
    `SELECT cm.media_item_id, c.id, c.name FROM collections c
     JOIN collection_members cm ON cm.collection_id = c.id
     WHERE cm.media_item_id = ANY($1::uuid[]) ORDER BY c.sort_order, c.name`,
    [ids],
  );
  const group = <T extends { media_item_id: string }>(rows: T[]) => {
    const byItem = new Map<string, Omit<T, "media_item_id">[]>();
    for (const { media_item_id, ...rest } of rows) {
      const list = byItem.get(media_item_id) ?? [];
      list.push(rest);
      byItem.set(media_item_id, list);
    }
    return byItem;
  };
  for (const row of sources.rows) {
    row.cloud_object_key = null;
    row.transfer_status = "idle";
    row.transfer_error = null;
    row.canonical_url = null;
    row.provider = null;
    row.provider_video_id = null;
    row.analyzed_at = null;
    row.analysis_error = null;
  }
  const sourcesByItem = group(sources.rows);
  const progressByItem = group(progress.rows);
  const collectionsByItem = group(collections.rows);
  return items.rows.map((item) => ({
    ...item,
    poster_url: null,
    backdrop_url: null,
    sources: sourcesByItem.get(item.id) ?? [],
    collections: collectionsByItem.get(item.id) ?? [],
    progress: progressByItem.get(item.id)?.[0] ?? null,
    in_my_list: myList.has(item.id),
  }));
}

export async function importItem(
  db: PGlite,
  householdId: string,
  body: {
    origin_filename: string;
    origin_identity: string;
    title?: string;
    duration_seconds?: number;
    serving_device_id?: string;
    poster_url?: string;
    media_type?: "movie" | "tv";
    series_identity?: string;
    season_number?: number;
    episode_number?: number;
    episode_title?: string;
    genres?: string[];
    match_status?: string;
    stable_source_key?: string;
    phone_location?: string;
    source_fingerprint?: string;
    private?: boolean;
  },
) {
  const existing = await db.query<{ id: string; media_item_id: string; title: string }>(
    `SELECT id, media_item_id
            , (SELECT title FROM media_items WHERE id = media_sources.media_item_id) AS title
       FROM media_sources
      WHERE household_id = $1
        AND (
          origin_identity = $2
          OR stable_source_key IS NOT NULL AND stable_source_key = $4
          OR phone_location IS NOT NULL AND phone_location = $5
          OR source_fingerprint IS NOT NULL AND source_fingerprint = $6
          OR (kind = 'phone_local' AND LOWER(origin_filename) = LOWER($3)
              AND ($4::text IS NULL OR stable_source_key IS NULL)
              AND ($6::text IS NULL OR source_fingerprint IS NULL))
        )
      ORDER BY CASE
          WHEN stable_source_key IS NOT NULL AND stable_source_key = $4 THEN 0
          WHEN phone_location IS NOT NULL AND phone_location = $5 THEN 1
          WHEN source_fingerprint IS NOT NULL AND source_fingerprint = $6 THEN 2
          WHEN origin_identity = $2 THEN 3
          ELSE 4
        END, id
      LIMIT 1`,
    [householdId, body.origin_identity, body.origin_filename, body.stable_source_key ?? null,
      body.phone_location ?? null, body.source_fingerprint ?? null],
  );

  if (existing.rows[0]) {
    const mediaItemId = existing.rows[0].media_item_id;
    const updated = await db.query<{ title: string }>(
      `UPDATE media_items
       SET title = CASE WHEN 'title' = ANY(user_metadata_fields) THEN title ELSE COALESCE($1, title) END,
           duration_seconds = COALESCE($2, duration_seconds),
           media_type = CASE WHEN 'media_type' = ANY(user_metadata_fields) THEN media_type ELSE COALESCE($3, media_type) END,
           series_identity = COALESCE($4, series_identity),
           season_number = COALESCE($5, season_number),
           episode_number = COALESCE($6, episode_number),
           episode_title = COALESCE($7, episode_title),
           genres = COALESCE($8, genres),
           match_status = COALESCE($9, match_status),
           updated_at = NOW()
       WHERE id = $10 AND household_id = $11 RETURNING title`,
      [body.title?.trim() || null, body.duration_seconds ?? null,
        body.media_type ?? null, body.series_identity ?? null, body.season_number ?? null,
        body.episode_number ?? null, body.episode_title ?? null, body.genres ?? null,
        body.match_status ?? null, mediaItemId, householdId],
    );
    await db.query(
      `UPDATE media_sources
       SET origin_filename = $1,
           -- The phone's current local id: after a reinstall the fingerprint re-attaches
           -- this source, and the old id made remote play (title_unavailable) and /media/<id> fail.
           origin_identity = CASE WHEN EXISTS (
               SELECT 1 FROM media_sources o
                WHERE o.household_id = media_sources.household_id AND o.origin_identity = $8
                  AND o.id <> media_sources.id) THEN origin_identity ELSE $8 END,
           serving_device_id = COALESCE($2, serving_device_id),
           availability = 'likely',
           stable_source_key = COALESCE($3, stable_source_key),
           phone_location = COALESCE($4, phone_location),
           source_fingerprint = COALESCE($5, source_fingerprint),
           archive_state = 'active',
           private = COALESCE($6, private),
           last_seen_at = NOW()
       WHERE id = $7`,
      [body.origin_filename, body.serving_device_id ?? null, body.stable_source_key ?? null,
        body.phone_location ?? null, body.source_fingerprint ?? null, body.private ?? null,
        existing.rows[0].id, body.origin_identity],
    );
    return { id: mediaItemId, title: updated.rows[0].title, origin_filename: body.origin_filename, created: false };
  }

  const id = randomUUID();
  const title = defaultTitle(body.origin_filename, body.title);
  await db.query(
    `INSERT INTO media_items
       (id, household_id, title, original_display_hint, duration_seconds,
        media_type, series_identity, season_number, episode_number, episode_title,
        genres, match_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [id, householdId, title, body.origin_filename, body.duration_seconds ?? null,
      body.media_type ?? "movie", body.series_identity ?? null, body.season_number ?? null,
      body.episode_number ?? null, body.episode_title ?? null, body.genres ?? [],
      body.match_status ?? "unmatched"],
  );
  await db.query(
    `INSERT INTO media_sources
       (id, media_item_id, household_id, kind, origin_filename, origin_identity,
        serving_device_id, availability, stable_source_key, phone_location,
        source_fingerprint, private, last_seen_at)
     VALUES ($1, $2, $3, 'phone_local', $4, $5, $6, 'likely', $7, $8, $9, $10, NOW())`,
    [
      randomUUID(),
      id,
      householdId,
      body.origin_filename,
      body.origin_identity,
      body.serving_device_id ?? null,
      body.stable_source_key ?? null,
      body.phone_location ?? null,
      body.source_fingerprint ?? null,
      body.private ?? false,
    ],
  );
  return { id, title, origin_filename: body.origin_filename, created: true };
}

export type TelegramSourceInput = {
  origin_filename: string;
  origin_identity: string; // tg:<chat_id>:<message_id>
  stable_source_key: string; // tgfile:<remote unique file id>
  title?: string;
  duration_seconds?: number;
  bytes_total?: number;
  playback_mime?: string;
  poster_url?: string;
  media_type?: "movie" | "tv";
  series_identity?: string;
  season_number?: number;
  episode_number?: number;
  episode_title?: string;
  genres?: string[];
  match_status?: string;
};

export async function importTelegramItem(db: PGlite, householdId: string, body: TelegramSourceInput) {
  return db.transaction(async (db) => {
    const existing = await db.query<{ id: string; media_item_id: string; title: string }>(
      `SELECT s.id, s.media_item_id, i.title FROM media_sources s JOIN media_items i ON i.id = s.media_item_id
        WHERE s.household_id = $1 AND s.kind = 'telegram' AND s.stable_source_key = $2
        ORDER BY s.id LIMIT 1`,
      [householdId, body.stable_source_key],
    );
    if (existing.rows[0]) {
      await db.query(
        `UPDATE media_sources SET origin_identity = CASE WHEN EXISTS (
             SELECT 1 FROM media_sources o WHERE o.household_id = media_sources.household_id
               AND o.origin_identity = $2 AND o.id <> media_sources.id) THEN origin_identity ELSE $2 END,
           origin_filename = $3, availability = 'available', archive_state = 'active',
           bytes_total = COALESCE($4, bytes_total), playback_mime = COALESCE($5, playback_mime), last_seen_at = NOW()
         WHERE id = $1`,
        [existing.rows[0].id, body.origin_identity, body.origin_filename, body.bytes_total ?? null, body.playback_mime ?? null],
      );
      return { id: existing.rows[0].media_item_id, title: existing.rows[0].title, origin_filename: body.origin_filename, created: false };
    }
    const id = randomUUID();
    const title = defaultTitle(body.origin_filename, body.title);
    await db.query(
      `INSERT INTO media_items
         (id, household_id, title, original_display_hint, duration_seconds,
          media_type, series_identity, season_number, episode_number, episode_title, genres, match_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, householdId, title, body.origin_filename, body.duration_seconds ?? null,
        body.media_type ?? "movie", body.series_identity ?? null, body.season_number ?? null,
        body.episode_number ?? null, body.episode_title ?? null, body.genres ?? [], body.match_status ?? "unmatched"],
    );
    await db.query(
      `INSERT INTO media_sources
         (id, media_item_id, household_id, kind, origin_filename, origin_identity, serving_device_id,
          availability, stable_source_key, bytes_total, playback_mime, private, last_seen_at)
       VALUES ($1, $2, $3, 'telegram', $4, $5, NULL, 'available', $6, $7, $8, FALSE, NOW())`,
      [randomUUID(), id, householdId, body.origin_filename, body.origin_identity, body.stable_source_key,
        body.bytes_total ?? null, body.playback_mime ?? null],
    );
    return { id, title, origin_filename: body.origin_filename, created: true };
  });
}

export async function attachTelegramSource(db: PGlite, householdId: string, itemId: string, body: TelegramSourceInput) {
  return db.transaction(async (db) => {
    const item = await db.query<{ title: string }>(
      `SELECT title FROM media_items WHERE id = $1 AND household_id = $2 AND hidden_at IS NULL`,
      [itemId, householdId],
    );
    if (!item.rows[0]) throw Object.assign(new Error("not_found"), { statusCode: 404 });
    const existing = await db.query<{ id: string; media_item_id: string }>(
      `SELECT id, media_item_id FROM media_sources
        WHERE household_id = $1 AND kind = 'telegram' AND stable_source_key = $2 ORDER BY id LIMIT 1`,
      [householdId, body.stable_source_key],
    );
    const found = existing.rows[0];
    if (found) {
      if (found.media_item_id !== itemId) {
        const others = await db.query(
          `SELECT 1 FROM media_sources WHERE media_item_id = $1 AND id <> $2 AND archive_state <> 'archived'`,
          [found.media_item_id, found.id],
        );
        if (others.rows[0]) throw Object.assign(new Error("source_in_other_title"), { statusCode: 409 });
        await db.query(`UPDATE media_sources SET media_item_id = $1 WHERE id = $2`, [itemId, found.id]);
        await db.query(`UPDATE media_items SET hidden_at = NOW(), updated_at = NOW() WHERE id = $1`, [found.media_item_id]);
      }
      await db.query(
        `UPDATE media_sources SET origin_identity = CASE WHEN EXISTS (
             SELECT 1 FROM media_sources o WHERE o.household_id = media_sources.household_id
               AND o.origin_identity = $2 AND o.id <> media_sources.id) THEN origin_identity ELSE $2 END,
           origin_filename = $3, availability = 'available', archive_state = 'active',
           bytes_total = COALESCE($4, bytes_total), playback_mime = COALESCE($5, playback_mime), last_seen_at = NOW()
         WHERE id = $1`,
        [found.id, body.origin_identity, body.origin_filename, body.bytes_total ?? null, body.playback_mime ?? null],
      );
      return { id: itemId, title: item.rows[0].title, origin_filename: body.origin_filename, created: false };
    }
    await db.query(
      `INSERT INTO media_sources
         (id, media_item_id, household_id, kind, origin_filename, origin_identity, serving_device_id,
          availability, stable_source_key, bytes_total, playback_mime, private, last_seen_at)
       VALUES ($1, $2, $3, 'telegram', $4, $5, NULL, 'available', $6, $7, $8, FALSE, NOW())`,
      [randomUUID(), itemId, householdId, body.origin_filename, body.origin_identity, body.stable_source_key,
        body.bytes_total ?? null, body.playback_mime ?? null],
    );
    return { id: itemId, title: item.rows[0].title, origin_filename: body.origin_filename, created: true };
  });
}

export async function reconcileTelegramSources(db: PGlite, householdId: string, present: string[]) {
  const gone = await db.query(
    `UPDATE media_sources SET availability = 'unavailable'
      WHERE household_id = $1 AND kind = 'telegram' AND NOT (stable_source_key = ANY($2::text[]))
        AND availability <> 'unavailable'`,
    [householdId, present],
  );
  const back = await db.query(
    `UPDATE media_sources SET availability = 'available', last_seen_at = NOW()
      WHERE household_id = $1 AND kind = 'telegram' AND stable_source_key = ANY($2::text[])`,
    [householdId, present],
  );
  return { unavailable: gone.affectedRows ?? 0, available: back.affectedRows ?? 0 };
}

export async function listCollections(db: PGlite, householdId: string) {
  const result = await db.query(
    `SELECT c.id, c.name, c.sort_order, COUNT(cm.media_item_id)::int AS item_count
       FROM collections c
       LEFT JOIN collection_members cm ON cm.collection_id = c.id
      WHERE c.household_id = $1
      GROUP BY c.id
      ORDER BY c.sort_order, c.name`,
    [householdId],
  );
  return result.rows;
}

export async function createCollection(db: PGlite, householdId: string, name: string) {
  const id = randomUUID();
  try {
    await db.query(
      `INSERT INTO collections (id, household_id, name)
       VALUES ($1, $2, $3)`,
      [id, householdId, name.trim()],
    );
  } catch (error) {
    if (String(error).toLowerCase().includes("duplicate")) {
      throw Object.assign(new Error("collection_exists"), { statusCode: 409 });
    }
    throw error;
  }
  return { id, name: name.trim(), item_count: 0 };
}

export async function deleteCollection(db: PGlite, householdId: string, collectionId: string) {
  const result = await db.query(
    `DELETE FROM collections WHERE id = $1 AND household_id = $2`,
    [collectionId, householdId],
  );
  if (result.affectedRows !== 1) throw Object.assign(new Error("collection_not_found"), { statusCode: 404 });
}

export async function setCollectionMember(
  db: PGlite,
  householdId: string,
  collectionId: string,
  itemId: string,
  present: boolean,
) {
  const authorized = await db.query(
    `SELECT 1
       FROM collections c
       JOIN media_items i ON i.household_id = c.household_id
      WHERE c.id = $1 AND i.id = $2 AND c.household_id = $3`,
    [collectionId, itemId, householdId],
  );
  if (!authorized.rows[0]) throw Object.assign(new Error("not_found"), { statusCode: 404 });
  if (present) {
    await db.query(
      `INSERT INTO collection_members (collection_id, media_item_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [collectionId, itemId],
    );
  } else {
    await db.query(
      `DELETE FROM collection_members WHERE collection_id = $1 AND media_item_id = $2`,
      [collectionId, itemId],
    );
  }
  return { collection_id: collectionId, item_id: itemId, present };
}

export async function reconcilePhoneSources(
  db: PGlite,
  householdId: string,
  presentSources: Array<{ stable_source_key?: string; phone_location?: string; source_fingerprint?: string }>,
  servingDeviceId?: string,
) {
  const keys = presentSources.flatMap((source) => [
    source.stable_source_key,
    source.phone_location,
    source.source_fingerprint,
  ]).filter((value): value is string => Boolean(value));
  const result = await db.query(
    `UPDATE media_sources
        SET archive_state = 'archived', availability = 'unavailable'
      WHERE household_id = $1
        AND kind = 'phone_local'
        AND (serving_device_id = $3::uuid OR ($3::uuid IS NULL AND serving_device_id IS NULL))
        AND archive_state <> 'archived'
        AND COALESCE(stable_source_key, phone_location, source_fingerprint) IS NOT NULL
        AND NOT (
          COALESCE(stable_source_key = ANY($2::text[]), FALSE)
          OR COALESCE(phone_location = ANY($2::text[]), FALSE)
          OR COALESCE(source_fingerprint = ANY($2::text[]), FALSE)
        )`,
    [householdId, keys, servingDeviceId ?? null],
  );
  return { archived_count: result.affectedRows ?? 0 };
}
