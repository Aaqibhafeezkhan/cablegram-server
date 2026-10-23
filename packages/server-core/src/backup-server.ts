import { createServer } from "node:http";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";

/** A live filesystem snapshot must wait for entire transactions, not just SQL statements. */
export async function snapshotDatabase(db: PGlite): Promise<Blob> {
  await db.exec("CHECKPOINT");
  return db._runExclusiveTransaction(() => db.runExclusive(() => db.dumpDataDir("gzip")));
}

/**
 * Default socket for a data directory. It must live outside that directory: `dumpDataDir` archives every
 * file in it and fails on a socket.
 */
export function defaultBackupSocketPath(dataDir: string): string {
  const id = createHash("sha256").update(resolve(dataDir)).digest("hex").slice(0, 12);
  return join(tmpdir(), `cablegram-backup-${id}.sock`);
}

export type BackupServerOptions = {
  onSetupCode?: () => Promise<{ code: string; expires_at: string }>;
};

/** Optional root/private UNIX socket; no route is added to the public API. */
export async function startBackupServer(db: PGlite, socketPath: string, options: BackupServerOptions = {}) {
  const existing = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (existing) {
    if (!existing.isSocket()) throw new Error("Backup socket path is not a socket");
    await unlink(socketPath);
  }
  let busy = false;
  const server = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/setup-code" && options.onSetupCode) {
      try {
        const issued = await options.onSetupCode();
        const body = Buffer.from(JSON.stringify(issued));
        res.writeHead(200, { "content-type": "application/json", "content-length": body.length, "cache-control": "no-store" });
        res.end(body);
      } catch {
        res.writeHead(500).end();
      }
      return;
    }
    if (req.method !== "POST" || req.url !== "/snapshot") {
      res.writeHead(404).end();
      return;
    }
    if (busy) {
      res.writeHead(409).end();
      return;
    }
    busy = true;
    try {
      const dump = await snapshotDatabase(db);
      const body = Buffer.from(await dump.arrayBuffer());
      res.writeHead(200, {
        "content-type": "application/gzip",
        "content-length": body.length,
        "cache-control": "no-store",
      });
      res.end(body);
    } catch (error) {
      res.writeHead(500).end();
      console.error("Database snapshot failed", error);
    } finally {
      busy = false;
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);
  return server;
}
