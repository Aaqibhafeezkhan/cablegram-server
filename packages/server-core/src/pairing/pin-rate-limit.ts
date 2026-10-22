const fails = new Map<string, { n: number; until: number }>();

export function checkPinRate(key: string, error = "too_many_pin_attempts"): void {
  const now = Date.now();
  const rec = fails.get(key);
  if (rec && rec.until > now && rec.n >= 8) {
    throw Object.assign(new Error(error), { statusCode: 429 });
  }
}

export function recordPinFail(key: string): void {
  const now = Date.now();
  const rec = fails.get(key) ?? { n: 0, until: now + 15 * 60_000 };
  rec.n += 1;
  rec.until = now + 15 * 60_000;
  fails.set(key, rec);
}

export function clearPinFail(key: string): void {
  fails.delete(key);
}
