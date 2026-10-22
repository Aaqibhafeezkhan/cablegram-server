import type { PGlite } from "@electric-sql/pglite";

export type MetadataPatch = {
  title?: string;
  year?: number | null;
  overview?: string | null;
  media_type?: "movie" | "tv";
  expected_revision?: number;
  edit_id?: string;
};

/** One atomic, household-scoped edit; retries of an acknowledged edit are harmless. */
export async function patchMetadata(db: PGlite, householdId: string, itemId: string, body: MetadataPatch) {
  return db.transaction(async tx => {
    const found = await tx.query<{ metadata_revision: number; metadata_edit_id: string | null }>(
      `SELECT metadata_revision, metadata_edit_id FROM media_items
       WHERE id = $1 AND household_id = $2 FOR UPDATE`, [itemId, householdId],
    );
    const current = found.rows[0];
    if (!current) throw Object.assign(new Error("not_found"), { statusCode: 404 });
    const read = async () => (await tx.query(
      `SELECT id, title, year, description AS overview, media_type, user_metadata_fields, metadata_revision,
              (SELECT origin_filename FROM media_sources WHERE media_item_id = media_items.id LIMIT 1) AS origin_filename
       FROM media_items WHERE id = $1 AND household_id = $2`, [itemId, householdId],
    )).rows[0];
    if (body.edit_id && body.edit_id === current.metadata_edit_id) return { conflict: false, item: await read() };
    if (body.expected_revision !== undefined && body.expected_revision !== current.metadata_revision) {
      return { conflict: true, item: await read() };
    }
    const columns = { title: "title", year: "year", overview: "description", media_type: "media_type" } as const;
    const fields = (Object.keys(columns) as Array<keyof typeof columns>).filter(key => body[key] !== undefined);
    const values: unknown[] = fields.map(key => body[key]);
    const assignments = fields.map((key, i) => `${columns[key]} = $${i + 1}`);
    values.push(fields, body.edit_id ?? null, itemId, householdId);
    const n = fields.length;
    await tx.query(
      `UPDATE media_items SET ${assignments.join(", ")},
         user_metadata_fields = ARRAY(SELECT DISTINCT unnest(user_metadata_fields || $${n + 1}::text[])),
         metadata_revision = metadata_revision + 1, metadata_edit_id = $${n + 2}, updated_at = NOW()
       WHERE id = $${n + 3} AND household_id = $${n + 4}`, values,
    );
    return { conflict: false, item: await read() };
  });
}
