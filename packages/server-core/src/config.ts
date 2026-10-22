import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const production = process.env.NODE_ENV === "production";

/** A positive integer setting; unset or blank gives [fallback], anything else is a startup error. */
export function positiveIntSetting(name: string, raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (!value) return fallback;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive integer (got "${raw}").`);
  }
  return Number(value);
}

export type PersistedSecrets = {
  jwtSecret: string;
  pinPepper: string;
};

/**
 * First-start secret initialization for self-hosted Community deployments:
 * When JWT_SECRET or PIN_PEPPER is unset, generates 32 random bytes each into
 * `<dataDir>/secrets.json` (mode 0600) and reuses them on later starts.
 * Production still refuses `dev-` defaults.
 */
export function loadOrCreateSecrets(dataDir: string, env: NodeJS.ProcessEnv = process.env): PersistedSecrets {
  const envJwt = env.JWT_SECRET?.trim();
  const envPepper = env.PIN_PEPPER?.trim();
  if (envJwt?.startsWith("dev-") || envPepper?.startsWith("dev-")) {
    if (env.NODE_ENV === "production") {
      throw new Error("Set JWT_SECRET and PIN_PEPPER in production (not the dev defaults).");
    }
  }
  if (envJwt && envPepper) {
    return { jwtSecret: envJwt, pinPepper: envPepper };
  }
  mkdirSync(dataDir, { recursive: true });
  const secretsPath = join(dataDir, "secrets.json");
  let stored: Partial<PersistedSecrets> = {};
  if (existsSync(secretsPath)) {
    try {
      stored = JSON.parse(readFileSync(secretsPath, "utf8")) as Partial<PersistedSecrets>;
    } catch {
      throw new Error(`Failed to parse ${secretsPath}`);
    }
  }
  const jwtSecret = envJwt || stored.jwtSecret || randomBytes(32).toString("base64url");
  const pinPepper = envPepper || stored.pinPepper || randomBytes(32).toString("base64url");
  if (!envJwt || !envPepper) {
    writeFileSync(secretsPath, JSON.stringify({ jwtSecret, pinPepper }, null, 2) + "\n", { mode: 0o600 });
    chmodSync(secretsPath, 0o600);
  }
  return { jwtSecret, pinPepper };
}

const jwtSecret = process.env.JWT_SECRET ?? "dev-jwt-secret-change-me";
const pinPepper = process.env.PIN_PEPPER ?? "dev-pin-pepper";

if (production && (jwtSecret.startsWith("dev-") || pinPepper.startsWith("dev-"))) {
  throw new Error("Set JWT_SECRET and PIN_PEPPER in production (not the dev defaults).");
}

export const coreConfig = {
  production,
  port: Number(process.env.PORT ?? 3000),
  jwtSecret,
  pinPepper,
  dataDir: process.env.PGLITE_DIR ?? new URL("../../../data", import.meta.url).pathname,
  requireTls: process.env.REQUIRE_TLS === "true" || (production && process.env.REQUIRE_TLS !== "false"),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || undefined,
  webAppOrigins: process.env.WEB_APP_ORIGINS || undefined,
  serverVersion: process.env.SERVER_VERSION || "0.1.0",
};
