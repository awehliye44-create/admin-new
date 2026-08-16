/** UK postcode helpers for place / postcode lookup Edges. */

export function extractUkPostcodeFromText(text: string): string | null {
  const m = String(text ?? "").toUpperCase().match(
    /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/,
  );
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

export function normalizeUkPostcodeQuery(raw: string): string {
  return String(raw ?? "").toUpperCase().replace(/\s+/g, " ").trim();
}

export function ukOutwardAreasMatch(a: string, b: string): boolean {
  const out = (s: string) => normalizeUkPostcodeQuery(s).split(/\s+/)[0] ?? "";
  return Boolean(out(a) && out(a) === out(b));
}

export function scoreUkPostcodeSuggestion(query: string, candidate: string): number {
  const q = normalizeUkPostcodeQuery(query).replace(/\s+/g, "");
  const c = normalizeUkPostcodeQuery(candidate).replace(/\s+/g, "");
  if (!q || !c) return 0;
  if (c === q) return 100;
  if (c.startsWith(q)) return 80;
  if (c.includes(q)) return 40;
  return 0;
}
