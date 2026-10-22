import { readdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { coreConfig } from "./config.ts";
import type { CablegramPlugin } from "./plugins.ts";

const dir = dirname(fileURLToPath(import.meta.url));
export const CORE_MIGRATIONS_DIR = join(dir, "migrations");

export type MigrationStream = {
  module: string;
  dir: string;
};

function parseVersion(filename: string): number {
  const m = /^0*(\d+)_/.exec(filename);
  if (!m) throw new Error(`Invalid migration filename "${filename}"`);
  return Number(m[1]);
}

async function ensureMigrationsTable(client: PGlite): Promise<void> {
  await client.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      module TEXT NOT NULL DEFAULT 'core',
      version INT NOT NULL DEFAULT 1,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS module TEXT NOT NULL DEFAULT 'core';
    ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;
  `);
}

/**
 * Applies migration streams in order (core first, then each plugin in registration order).
 * Refuses to start if the database schema for any module is newer than the binary (downgrade protection).
 */
export async function runMigrationStreams(client: PGlite, streams: MigrationStream[]): Promise<void> {
  await ensureMigrationsTable(client);

  for (const stream of streams) {
    const files = readdirSync(stream.dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const maxKnownVersion = files.reduce((max, f) => Math.max(max, parseVersion(f)), 0);
    const appliedMax = await client.query<{ max_ver: number | null }>(
      `SELECT MAX(version) AS max_ver FROM schema_migrations WHERE module = $1`,
      [stream.module],
    );
    const dbVersion = appliedMax.rows[0]?.max_ver ?? 0;
    if (dbVersion > maxKnownVersion) {
      throw new Error(
        `Database schema for module "${stream.module}" is at version ${dbVersion}, which is newer than binary version ${maxKnownVersion}. Downgrades are not supported.`,
      );
    }

    for (const file of files) {
      const base = file.replace(/\.sql$/, "");
      const id = `${stream.module}:${base}`;
      const version = parseVersion(file);
      const applied = await client.query<{ id: string }>(
        `SELECT id FROM schema_migrations WHERE id = $1 OR (module = $2 AND version = $3)`,
        [id, stream.module, version],
      );
      if (applied.rows.length === 0) {
        const sql = readFileSync(join(stream.dir, file), "utf8");
        await client.exec(sql);
        await client.query(
          `INSERT INTO schema_migrations (id, module, version) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
          [id, stream.module, version],
        );
      }
    }
  }
}

export async function migrateCore(
  client: PGlite,
  plugins: Array<CablegramPlugin | MigrationStream> = [],
): Promise<void> {
  const streams: MigrationStream[] = [{ module: "core", dir: CORE_MIGRATIONS_DIR }];
  for (const item of plugins) {
    if ("dir" in item && "module" in item) {
      streams.push({ module: item.module, dir: item.dir });
    } else if (item.migrations?.dir) {
      streams.push({ module: item.name, dir: item.migrations.dir });
    }
  }
  await runMigrationStreams(client, streams);
}

export async function createCoreTestDb(plugins: CablegramPlugin[] = []): Promise<PGlite> {
  const client = new PGlite();
  await migrateCore(client, plugins);
  return client;
}

export async function wipeCoreDatabase(dataDir = coreConfig.dataDir): Promise<void> {
  await rm(dataDir, { recursive: true, force: true });
}
