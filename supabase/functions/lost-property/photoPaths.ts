/**
 * Lost property photo paths must live inside the case's own storage folder
 * (`<case_id>/...`). This mirrors the storage upload policy and stops a caller
 * from pointing a case at another user's files, which the scheduled cleanup
 * would otherwise delete.
 */

export const MAX_CASE_PHOTOS = 4;
const MAX_PATH_LENGTH = 512;

export type CasePhotoPathResult =
  | { ok: true; paths: string[] }
  | { ok: false; error: string };

export function isCasePhotoPath(path: string, caseId: string): boolean {
  if (!caseId || path.length > MAX_PATH_LENGTH) return false;
  if (!path.startsWith(`${caseId}/`)) return false;
  const rest = path.slice(caseId.length + 1);
  if (!rest) return false;
  return !rest.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

export function validateCasePhotoPaths(raw: unknown, caseId: string): CasePhotoPathResult {
  if (raw === undefined || raw === null) return { ok: true, paths: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "Photos must be a list of file paths" };
  if (raw.length > MAX_CASE_PHOTOS) {
    return { ok: false, error: `Maximum ${MAX_CASE_PHOTOS} photos allowed` };
  }

  const paths: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return { ok: false, error: "Invalid photo path for report" };
    const path = item.trim();
    if (!path) continue;
    if (!isCasePhotoPath(path, caseId)) return { ok: false, error: "Invalid photo path for report" };
    paths.push(path);
  }
  return { ok: true, paths };
}

/** Keeps only paths inside the case folder; used before any storage deletion. */
export function filterCasePhotoPaths(raw: unknown, caseId: string): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((path) => isCasePhotoPath(path, caseId));
}
