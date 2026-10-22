import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { coreConfig } from "../config.ts";

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, 10);
}

export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pin, hash);
}

// Legacy aliases retained for callers migrating from auth/secrets.ts
export const hashPassword = hashPin;
export const verifyPassword = verifyPin;

export function pinLookup(pin: string): string {
  return createHmac("sha256", coreConfig.pinPepper).update(pin).digest("hex");
}

export function hashToken(token: string): string {
  return createHmac("sha256", coreConfig.pinPepper).update(token).digest("hex");
}

export function randomPin(digits = 6): string {
  return String(randomInt(0, 10 ** digits)).padStart(digits, "0");
}

export function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Keyed hash of a hardware id (ANDROID_ID); the raw value is never stored. */
export function hardwareHash(raw: string | undefined | null): string | null {
  const value = raw?.trim();
  if (!value || value.length < 8 || value.length > 128) return null;
  return createHmac("sha256", coreConfig.pinPepper).update(`hw:${value}`).digest("hex");
}
