/**
 * Admin mirror of Driver document capture-side heuristics.
 * Source of truth for behaviour: Driver `documentNeedsCaptureSides` /
 * `resolveNamedSingleDocumentSide` — name/code only, never catalogue description.
 */

export type AdminDocumentCaptureLayout =
  | { kind: 'single'; submitSide: 'single' }
  | { kind: 'front_only'; submitSide: 'front' }
  | { kind: 'back_only'; submitSide: 'back' }
  | { kind: 'dual'; submitSides: ['front', 'back'] };

function documentTypeHaystack(input: {
  code?: string | null;
  name?: string | null;
}): string {
  return [input.code, input.name]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .join(' ')
    .toLowerCase();
}

/** Admin split Front/Back into separate types → one file each, not dual-side. */
export function resolveNamedSingleDocumentSide(input: {
  code?: string | null;
  name?: string | null;
}): 'front' | 'back' | null {
  const haystack = documentTypeHaystack(input);
  if (!haystack) return null;
  if (
    haystack.includes('front and back') ||
    haystack.includes('front & back') ||
    haystack.includes('front/back')
  ) {
    return null;
  }

  const hasFront =
    /\bfront\b/.test(haystack) ||
    /(?:^|[\s_-])front(?:$|[\s_-])/.test(haystack) ||
    /_front\b/.test(haystack);
  const hasBack =
    /\bback\b/.test(haystack) ||
    /(?:^|[\s_-])back(?:$|[\s_-])/.test(haystack) ||
    /_back\b/.test(haystack);

  if (hasFront && !hasBack) return 'front';
  if (hasBack && !hasFront) return 'back';
  return null;
}

export function documentNeedsCaptureSides(input: {
  code?: string | null;
  name?: string | null;
}): boolean {
  const haystack = documentTypeHaystack(input);

  if (
    haystack.includes('front and back') ||
    haystack.includes('front & back') ||
    haystack.includes('front/back')
  ) {
    return true;
  }

  if (resolveNamedSingleDocumentSide(input) != null) {
    return false;
  }

  const isLicence =
    haystack.includes('licence') || haystack.includes('license') || haystack.includes('dvla');
  const isDriving = haystack.includes('driving') || haystack.includes('dvla');
  return isLicence && isDriving;
}

/** Layout for Admin Add Documents file inputs + RPC p_side. */
export function resolveAdminDocumentCaptureLayout(input: {
  code?: string | null;
  name?: string | null;
}): AdminDocumentCaptureLayout {
  if (documentNeedsCaptureSides(input)) {
    return { kind: 'dual', submitSides: ['front', 'back'] };
  }
  const named = resolveNamedSingleDocumentSide(input);
  if (named === 'front') return { kind: 'front_only', submitSide: 'front' };
  if (named === 'back') return { kind: 'back_only', submitSide: 'back' };
  return { kind: 'single', submitSide: 'single' };
}
