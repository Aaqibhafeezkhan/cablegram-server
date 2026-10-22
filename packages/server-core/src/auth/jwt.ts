import * as jose from "jose";
import { coreConfig } from "../config.ts";

function jwtKey() {
  return new TextEncoder().encode(coreConfig.jwtSecret);
}

export type PhoneClaims = {
  scope: "phone";
  sub: string;
  household_id: string;
  user_id: string;
  /** "web" for the iPhone PWA: a remote with no Telegram session. Absent for the native apps. */
  client?: "web";
};

export type TvClaims = {
  scope: "tv";
  sub: string;
  household_id: string;
  device_id: string;
};

export async function signPhone(userId: string, householdId: string, client?: "web"): Promise<string> {
  return new jose.SignJWT({ scope: "phone", user_id: userId, household_id: householdId, ...(client ? { client } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setExpirationTime("2h")
    .sign(jwtKey());
}

export async function signTv(deviceId: string, householdId: string): Promise<string> {
  return new jose.SignJWT({ scope: "tv", device_id: deviceId, household_id: householdId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(deviceId)
    .setExpirationTime("30d")
    .sign(jwtKey());
}

export async function verifyAccess(token: string): Promise<PhoneClaims | TvClaims> {
  const { payload } = await jose.jwtVerify(token, jwtKey());
  if (payload.scope === "phone") {
    return {
      scope: "phone",
      sub: String(payload.sub),
      household_id: String(payload.household_id),
      user_id: String(payload.user_id),
      ...(payload.client === "web" ? { client: "web" as const } : {}),
    };
  }
  if (payload.scope === "tv") {
    return {
      scope: "tv",
      sub: String(payload.sub),
      household_id: String(payload.household_id),
      device_id: String(payload.device_id),
    };
  }
  throw new Error("invalid_scope");
}
