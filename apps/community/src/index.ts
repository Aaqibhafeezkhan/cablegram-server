#!/usr/bin/env node
import { request } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  buildCoreApp,
  coreConfig,
  ensureInitialSetupCode,
  issueSetupCode,
  loadOrCreateSecrets,
  migrateCore,
  startBackupServer,
} from "../../../packages/server-core/src/index.ts";

const socketPath = process.env.BACKUP_SOCKET || join(coreConfig.dataDir, "backup.sock");

function callBackupSocket(path: string): Promise<{ statusCode: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, path, method: "POST" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ statusCode: res.statusCode ?? 500, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function runSetupCodeCli(): Promise<void> {
  loadOrCreateSecrets(coreConfig.dataDir);
  try {
    const res = await callBackupSocket("/setup-code");
    if (res.statusCode === 200) {
      const issued = JSON.parse(res.body.toString("utf8")) as { code: string; expires_at: string };
      console.log(`Setup code: ${issued.code} (expires at ${issued.expires_at})`);
      return;
    }
    throw new Error(`Backup socket returned HTTP ${res.statusCode}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ECONNREFUSED") {
      throw err;
    }
    mkdirSync(coreConfig.dataDir, { recursive: true });
    const db = new PGlite(coreConfig.dataDir);
    try {
      await migrateCore(db);
      const issued = await issueSetupCode(db);
      console.log(`Setup code: ${issued.code} (expires at ${issued.expires_at})`);
    } finally {
      await db.close();
    }
  }
}

async function runBackupCli(outputPath?: string): Promise<void> {
  const res = await callBackupSocket("/snapshot");
  if (res.statusCode !== 200) {
    throw new Error(`Live snapshot failed with HTTP ${res.statusCode}`);
  }
  if (!outputPath || outputPath === "-") {
    process.stdout.write(res.body);
    return;
  }
  writeFileSync(outputPath, res.body, { mode: 0o600 });
  console.log(`Snapshot written to ${outputPath} (${res.body.length} bytes)`);
}

async function startServer(): Promise<void> {
  mkdirSync(coreConfig.dataDir, { recursive: true });
  loadOrCreateSecrets(coreConfig.dataDir);
  const db = new PGlite(coreConfig.dataDir);
  await migrateCore(db);

  const initial = await ensureInitialSetupCode(db);
  if (initial) {
    console.log("============================================================");
    console.log("  Cablegram Community Server — First-Start Setup Code");
    console.log(`  Code:    ${initial.code}`);
    console.log(`  Expires: ${initial.expires_at}`);
    console.log("============================================================");
  }

  const backupServer = await startBackupServer(db, socketPath, {
    onSetupCode: () => issueSetupCode(db),
  });
  const app = await buildCoreApp(db, { edition: "community" });
  await app.listen({ port: coreConfig.port, host: "0.0.0.0" });
  console.log(`cablegram-server (community) listening on ${coreConfig.port}`);

  const shutdown = async () => {
    await app.close();
    backupServer.close();
    await db.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

const subcommand = process.argv[2];
if (subcommand === "setup-code") {
  await runSetupCodeCli();
} else if (subcommand === "backup") {
  await runBackupCli(process.argv[3]);
} else {
  await startServer();
}
