import type { FastifyInstance } from "fastify";
import type { PGlite } from "@electric-sql/pglite";
import { z } from "zod";
import { requireAuth } from "./authorize.ts";

const language = z.string().min(2).max(64).transform((tag, ctx) => {
  try {
    const canonical = Intl.getCanonicalLocales(tag)[0];
    if (canonical) return canonical;
  } catch { /* Report invalid tags through the normal validation response. */ }
  ctx.addIssue({ code: "custom", message: "Invalid language tag" });
  return z.NEVER;
});

/** Effective profile languages; TVs read these with their session check instead of polling profiles. */
export async function profileLanguages(db: PGlite, householdId: string) {
  const r = await db.query<{ id: string; ui_language: string }>(
    `SELECT p.id, COALESCE(p.ui_language, u.ui_language, 'en') AS ui_language
     FROM profiles p JOIN households h ON h.id = p.household_id
     LEFT JOIN users u ON u.id = h.created_by_user_id
     WHERE p.household_id = $1 ORDER BY p.sort_order`,
    [householdId],
  );
  return r.rows;
}

export function registerLanguageRoutes(app: FastifyInstance, db: PGlite) {
  app.put("/api/me/language", async req => {
    const auth = await requireAuth(req);
    if (auth.scope !== "phone") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    const body = z.object({ ui_language: language }).strict().parse(req.body);
    await db.query(`UPDATE users SET ui_language = $1 WHERE id = $2`, [body.ui_language, auth.user_id]);
    return body;
  });

  app.patch("/api/profiles/:profileId/language", async req => {
    const auth = await requireAuth(req);
    if (auth.scope !== "phone") throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    const { profileId } = z.object({ profileId: z.string().uuid() }).parse(req.params);
    const body = z.object({ ui_language: language.nullable() }).strict().parse(req.body);
    const result = await db.query(
      `UPDATE profiles SET ui_language = $1 WHERE id = $2 AND household_id = $3 RETURNING id`,
      [body.ui_language, profileId, auth.household_id],
    );
    if (!result.rows.length) throw Object.assign(new Error("profile_not_found"), { statusCode: 404 });
    return body;
  });
}
