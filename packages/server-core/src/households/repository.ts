import type { PGlite } from "@electric-sql/pglite";

export type HouseholdRow = {
  id: string;
  name: string;
  created_by_user_id: string | null;
  profile_lock: boolean;
  shared_tv_idle_minutes: number;
};

export async function insertHousehold(
  db: PGlite,
  row: { id: string; name: string },
): Promise<void> {
  await db.query(
    `INSERT INTO households (id, name) VALUES ($1, $2)`,
    [row.id, row.name],
  );
}

export async function setHouseholdCreator(db: PGlite, householdId: string, userId: string) {
  await db.query(`UPDATE households SET created_by_user_id = $1 WHERE id = $2`, [
    userId,
    householdId,
  ]);
}

export async function insertUser(
  db: PGlite,
  row: { id: string; email: string | null; household_id: string },
) {
  await db.query(
    `INSERT INTO users (id, email, household_id) VALUES ($1, $2, $3)`,
    [row.id, row.email, row.household_id],
  );
}

export async function findUserByEmail(db: PGlite, email: string) {
  const r = await db.query<{
    id: string;
    email: string;
    household_id: string;
  }>(`SELECT id, email, household_id FROM users WHERE email = $1`, [email]);
  return r.rows[0];
}

export async function getHousehold(db: PGlite, id: string) {
  const r = await db.query<HouseholdRow>(
    `SELECT id, name, created_by_user_id, profile_lock, shared_tv_idle_minutes FROM households WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}
