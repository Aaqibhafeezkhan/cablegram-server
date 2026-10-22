export function defaultTitle(originFilename: string, provided?: string): string {
  if (provided?.trim()) return provided.trim();
  return originFilename.replace(/\.[^.]+$/, "") || originFilename;
}

export function assertFilenamePreserved(existing: string, _incomingTitle: string) {
  return existing;
}
