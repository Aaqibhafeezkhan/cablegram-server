import type { PGlite } from "@electric-sql/pglite";

export type RemovalMode = "hide" | "delete" | "delete_source";

const fail = (status: number, code: string): never => {
  throw Object.assign(new Error(code), { statusCode: status });
};

type SourceRow = { id: string; stable_source_key: string; origin_identity: string };

/** chat and message of a `tg:<chat_id>:<message_id>` source. */
function locate(identity: string): { chat_id: string; message_id: string } | null {
  const m = /^tg:(-?\d+):(\d+)$/.exec(identity);
  return m ? { chat_id: m[1]!, message_id: m[2]! } : null;
}

export async function removeItem(
  db: PGlite,
  householdId: string,
  itemId: string,
  mode: RemovalMode,
  stableSourceKey?: string,
) {
  return db.transaction(async (tx) => {
    const item = await tx.query<{ title: string }>(
      `SELECT title FROM media_items WHERE id = $1 AND household_id = $2 AND hidden_at IS NULL`,
      [itemId, householdId],
    );
    if (!item.rows[0]) return fail(404, "not_found");
    const title = item.rows[0].title;
    const all = await tx.query<SourceRow>(
      `SELECT id, stable_source_key, origin_identity FROM media_sources
        WHERE media_item_id = $1 AND household_id = $2 AND kind = 'telegram'
          AND stable_source_key IS NOT NULL`,
      [itemId, householdId],
    );
    const targets = mode === "delete_source"
      ? all.rows.filter((s) => s.stable_source_key === stableSourceKey)
      : all.rows;
    if (mode === "delete_source" && targets.length === 0) return fail(404, "source_not_found");

    const state = mode === "hide" ? "hidden" : "deleting";
    const deletions: Array<{ stable_source_key: string; chat_id: number; message_ids: number[] }> = [];
    for (const source of targets) {
      const at = locate(source.origin_identity);
      const highWater = at
        ? (await tx.query<{ max: string | null }>(
            `SELECT MAX(substring(origin_identity FROM '^tg:-?\\d+:(\\d+)$')::BIGINT)::TEXT AS max FROM media_sources
              WHERE household_id = $1 AND kind = 'telegram' AND split_part(origin_identity, ':', 2) = $2`,
            [householdId, at.chat_id],
          )).rows[0]?.max ?? at.message_id
        : null;
      await tx.query(
        `INSERT INTO source_tombstones (household_id, stable_source_key, media_item_id, title, state, chat_id, message_ids, high_water_message_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::bigint[], $8)
         ON CONFLICT (household_id, stable_source_key) DO UPDATE SET
           media_item_id = EXCLUDED.media_item_id, title = EXCLUDED.title, state = EXCLUDED.state,
           chat_id = EXCLUDED.chat_id, message_ids = EXCLUDED.message_ids,
           high_water_message_id = EXCLUDED.high_water_message_id, last_error = NULL, updated_at = NOW()`,
        [householdId, source.stable_source_key, itemId, title, state, at?.chat_id ?? null, at ? [at.message_id] : [], highWater],
      );
      await tx.query(`UPDATE media_sources SET archive_state = 'archived' WHERE id = $1`, [source.id]);
      if (mode !== "hide" && at) {
        deletions.push({ stable_source_key: source.stable_source_key, chat_id: Number(at.chat_id), message_ids: [Number(at.message_id)] });
      }
    }
    if (mode !== "delete_source") {
      await tx.query(`UPDATE media_items SET hidden_at = NOW(), updated_at = NOW() WHERE id = $1`, [itemId]);
    }
    return mode === "hide" ? { ok: true } : { ok: true, telegram_deletions: deletions };
  });
}

export async function recordTombstoneResult(
  db: PGlite,
  householdId: string,
  stableSourceKey: string,
  result: { outcome: "deleted" } | { outcome: "failed"; error: string },
) {
  const r = await db.query(
    result.outcome === "deleted"
      ? `UPDATE source_tombstones SET state = 'deleted', last_error = NULL, updated_at = NOW()
          WHERE household_id = $1 AND stable_source_key = $2 AND state = 'deleting'`
      : `UPDATE source_tombstones SET last_error = $3, updated_at = NOW()
          WHERE household_id = $1 AND stable_source_key = $2 AND state = 'deleting'`,
    result.outcome === "deleted" ? [householdId, stableSourceKey] : [householdId, stableSourceKey, result.error],
  );
  if (r.affectedRows !== 1) fail(404, "tombstone_not_found");
  return { ok: true };
}

export async function listTombstones(db: PGlite, householdId: string) {
  const r = await db.query(
    `SELECT stable_source_key, media_item_id AS item_id, title, state, last_error
       FROM source_tombstones WHERE household_id = $1 AND state IN ('hidden', 'deleting')
      ORDER BY created_at DESC`,
    [householdId],
  );
  return r.rows;
}

export async function restoreTombstone(db: PGlite, householdId: string, stableSourceKey: string) {
  return db.transaction(async (tx) => {
    const t = await tx.query<{ media_item_id: string | null }>(
      `DELETE FROM source_tombstones WHERE household_id = $1 AND stable_source_key = $2 AND state = 'hidden'
       RETURNING media_item_id`,
      [householdId, stableSourceKey],
    );
    if (!t.rows[0]) return fail(404, "tombstone_not_found");
    await tx.query(
      `UPDATE media_sources SET archive_state = 'active'
        WHERE household_id = $1 AND kind = 'telegram' AND stable_source_key = $2`,
      [householdId, stableSourceKey],
    );
    if (t.rows[0].media_item_id) {
      await tx.query(`UPDATE media_items SET hidden_at = NULL, updated_at = NOW() WHERE id = $1`, [t.rows[0].media_item_id]);
    }
    return { ok: true };
  });
}

export async function blocksImport(db: PGlite, householdId: string, stableSourceKey: string, messageId: string) {
  return db.transaction(async (tx) => {
    const r = await tx.query<{ media_item_id: string | null; state: string; seen: boolean }>(
      `SELECT media_item_id, state,
              $3::bigint <= GREATEST(COALESCE(high_water_message_id, 0), COALESCE((SELECT MAX(m) FROM unnest(message_ids) m), 0)) AS seen
         FROM source_tombstones WHERE household_id = $1 AND stable_source_key = $2`,
      [householdId, stableSourceKey, messageId],
    );
    const t = r.rows[0];
    if (!t) return false;
    if (t.seen || t.state === "deleting") return true;
    await tx.query(`DELETE FROM source_tombstones WHERE household_id = $1 AND stable_source_key = $2`, [householdId, stableSourceKey]);
    if (t.media_item_id) await tx.query(`UPDATE media_items SET hidden_at = NULL, updated_at = NOW() WHERE id = $1`, [t.media_item_id]);
    return false;
  });
}
