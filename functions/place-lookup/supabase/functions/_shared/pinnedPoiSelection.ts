/** Pinned POI selection helpers for place-lookup. */

export function looksLikeStreetAddressName(name: string | null | undefined): boolean {
  const n = String(name ?? "").trim();
  if (!n) return false;
  return /\d/.test(n) || /\b(street|st|road|rd|avenue|ave|lane|ln|drive|dr|close|court|way)\b/i.test(n);
}

export function normalizeV6StreetAddress(name: string | null | undefined): string {
  return String(name ?? "").replace(/\s+/g, " ").trim();
}

export function choosePinnedPoi<T extends { name?: string | null; address?: string | null }>(
  rows: T[],
  query: string,
): T | null {
  if (!rows.length) return null;
  const q = query.trim().toLowerCase();
  const exact = rows.find((r) => String(r.name ?? "").toLowerCase() === q);
  return exact ?? rows[0] ?? null;
}
