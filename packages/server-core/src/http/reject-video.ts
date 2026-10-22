export function assertNotVideoBody(headers: Record<string, unknown>, body: unknown): void {
  const ct = String(headers["content-type"] ?? headers["Content-Type"] ?? "");
  if (ct.includes("video/") || ct.includes("multipart/form-data")) {
    throw Object.assign(new Error("video_not_allowed"), { statusCode: 415 });
  }
  if (body && typeof body === "object" && "video" in (body as object)) {
    throw Object.assign(new Error("video_not_allowed"), { statusCode: 415 });
  }
}
