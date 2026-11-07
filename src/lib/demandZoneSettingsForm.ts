/**
 * Pure helpers for Admin Heat map & surge settings dialog —
 * load/hydrate/save verification without touching production data.
 */

import {
  DEMAND_ZONE_SETTINGS_DEFAULTS,
  isValidHexColour,
  normaliseHexColour,
  type DemandZoneSettings,
} from '../../shared/demandZoneSurgeSSOT';

export type DemandZoneSettingsFormState = Omit<DemandZoneSettings, 'service_area_id'>;

export type DemandZoneSettingsLoadStatus =
  | 'idle'
  | 'loading'
  | 'error'
  | 'missing'
  | 'ready';

/** Fields the Admin dialog edits and must round-trip through save. */
export const DEMAND_ZONE_SETTINGS_EDIT_KEYS = [
  'heat_map_enabled',
  'manual_zones_enabled',
  'recompute_interval_minutes',
  'open_trip_max_lifetime_minutes',
  'zone_radius_meters',
  'consecutive_checks_required',
  'low_min_trips',
  'low_max_trips',
  'medium_min_trips',
  'medium_max_trips',
  'high_min_trips',
  'colour_low',
  'colour_medium',
  'colour_high',
  'surge_enabled',
  'multiplier_low',
  'multiplier_medium',
  'multiplier_high',
  'max_multiplier',
] as const satisfies ReadonlyArray<keyof DemandZoneSettingsFormState>;

export type DemandZoneSettingsEditKey = (typeof DEMAND_ZONE_SETTINGS_EDIT_KEYS)[number];

const NUMERIC_KEYS = new Set<DemandZoneSettingsEditKey>([
  'recompute_interval_minutes',
  'open_trip_max_lifetime_minutes',
  'zone_radius_meters',
  'consecutive_checks_required',
  'low_min_trips',
  'low_max_trips',
  'medium_min_trips',
  'medium_max_trips',
  'high_min_trips',
  'multiplier_low',
  'multiplier_medium',
  'multiplier_high',
  'max_multiplier',
]);

const COLOUR_KEYS = new Set<DemandZoneSettingsEditKey>([
  'colour_low',
  'colour_medium',
  'colour_high',
]);

export function starterDemandZoneSettingsForm(): DemandZoneSettingsFormState {
  return { ...DEMAND_ZONE_SETTINGS_DEFAULTS };
}

/** Never throws — incomplete hex stays usable as a CSS fallback only. */
export function safeHexColourForDisplay(
  value: string | null | undefined,
  fallback: string,
): string {
  if (isValidHexColour(value)) return normaliseHexColour(String(value));
  if (isValidHexColour(fallback)) return normaliseHexColour(fallback);
  return '#000000';
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/** Map a DB / RPC row into dialog form state (numeric jsonb strings coerced). */
export function mapDemandZoneSettingsRowToForm(
  row: Partial<DemandZoneSettings> | Record<string, unknown>,
): DemandZoneSettingsFormState {
  const base = starterDemandZoneSettingsForm();
  const out: DemandZoneSettingsFormState = { ...base };

  for (const key of DEMAND_ZONE_SETTINGS_EDIT_KEYS) {
    const raw = (row as Record<string, unknown>)[key];
    if (raw === undefined) continue;

    if (key === 'heat_map_enabled' || key === 'manual_zones_enabled' || key === 'surge_enabled') {
      out[key] = coerceBoolean(raw, base[key] as boolean);
      continue;
    }

    if (COLOUR_KEYS.has(key)) {
      const text = typeof raw === 'string' ? raw.trim() : String(raw ?? '');
      (out as unknown as Record<string, unknown>)[key] = isValidHexColour(text)
        ? normaliseHexColour(text)
        : text;
      continue;
    }

    if (NUMERIC_KEYS.has(key)) {
      if (raw === null) {
        if (key === 'multiplier_medium' || key === 'multiplier_high') {
          out[key] = null;
        }
        continue;
      }
      const n = coerceNumber(raw);
      if (n == null) continue;
      if (
        key === 'recompute_interval_minutes' ||
        key === 'open_trip_max_lifetime_minutes' ||
        key === 'zone_radius_meters' ||
        key === 'consecutive_checks_required' ||
        key === 'low_min_trips' ||
        key === 'low_max_trips' ||
        key === 'medium_min_trips' ||
        key === 'medium_max_trips' ||
        key === 'high_min_trips'
      ) {
        out[key] = Math.trunc(n);
      } else {
        out[key] = n as never;
      }
    }
  }

  return out;
}

function valuesEqual(a: unknown, b: unknown, key: DemandZoneSettingsEditKey): boolean {
  if (COLOUR_KEYS.has(key)) {
    const left = typeof a === 'string' ? a : '';
    const right = typeof b === 'string' ? b : '';
    if (isValidHexColour(left) && isValidHexColour(right)) {
      return normaliseHexColour(left) === normaliseHexColour(right);
    }
    return left.trim().toUpperCase() === right.trim().toUpperCase();
  }
  if (NUMERIC_KEYS.has(key)) {
    const left = coerceNumber(a);
    const right = coerceNumber(b);
    if (left == null && right == null) return true;
    if (left == null || right == null) return false;
    return Math.abs(left - right) < 1e-9;
  }
  return a === b;
}

export function demandZoneSettingsFormsEqual(
  a: DemandZoneSettingsFormState,
  b: DemandZoneSettingsFormState,
): boolean {
  return DEMAND_ZONE_SETTINGS_EDIT_KEYS.every((key) => valuesEqual(a[key], b[key], key));
}

/**
 * Compare submitted form to authoritative RPC/read-back row.
 * Returns mismatched field keys (empty = verified).
 */
export function verifyDemandZoneSettingsSaved(
  submitted: DemandZoneSettingsFormState,
  saved: Partial<DemandZoneSettings> | Record<string, unknown> | null | undefined,
): DemandZoneSettingsEditKey[] {
  if (!saved || typeof saved !== 'object') {
    return [...DEMAND_ZONE_SETTINGS_EDIT_KEYS];
  }
  const mapped = mapDemandZoneSettingsRowToForm(saved);
  return DEMAND_ZONE_SETTINGS_EDIT_KEYS.filter(
    (key) => !valuesEqual(submitted[key], mapped[key], key),
  );
}

export function buildDemandZoneSettingsSavePayload(
  form: DemandZoneSettingsFormState,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const key of DEMAND_ZONE_SETTINGS_EDIT_KEYS) {
    const value = form[key];
    if (COLOUR_KEYS.has(key) && typeof value === 'string' && isValidHexColour(value)) {
      payload[key] = normaliseHexColour(value);
      continue;
    }
    payload[key] = value;
  }
  return payload;
}

/**
 * Decide whether a background refetch may replace the form.
 * Dirty forms keep local edits; clean forms may adopt newer server data.
 */
export function shouldRehydrateDemandZoneSettingsForm(input: {
  loadStatus: DemandZoneSettingsLoadStatus;
  formDirty: boolean;
  baseline: DemandZoneSettingsFormState | null;
  incoming: DemandZoneSettingsFormState;
}): boolean {
  if (input.loadStatus !== 'ready') return false;
  if (!input.formDirty) return true;
  if (!input.baseline) return false;
  // Newer server data that still matches baseline → no user edits; safe.
  if (demandZoneSettingsFormsEqual(input.baseline, input.incoming)) return false;
  // Server moved while dirty — do not silently discard edits.
  return false;
}

export function serverSettingsAreNewerThanBaseline(input: {
  baseline: DemandZoneSettingsFormState | null;
  incoming: DemandZoneSettingsFormState;
  formDirty: boolean;
}): boolean {
  if (!input.baseline) return false;
  if (demandZoneSettingsFormsEqual(input.baseline, input.incoming)) return false;
  return input.formDirty;
}

/** PostgREST errors are plain objects — not always `instanceof Error`. */
export function formatDemandZoneSettingsLoadError(error: unknown): string {
  if (!error) return 'Unknown load error';
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const message = typeof record.message === 'string' ? record.message.trim() : '';
    const code = typeof record.code === 'string' ? record.code.trim() : '';
    const details = typeof record.details === 'string' ? record.details.trim() : '';
    if (message && code && details) return `${message} (${code}: ${details})`;
    if (message && code) return `${message} (${code})`;
    if (message) return message;
    if (code) return code;
  }
  if (typeof error === 'string' && error.trim()) return error;
  return 'Unknown load error';
}

/**
 * Select one settings row without maybeSingle().
 * Duplicate service_area_id rows make maybeSingle() throw PGRST116 even though a list read succeeds.
 */
export function pickDemandZoneSettingsRow<T>(
  rows: T[] | null | undefined,
): T | null {
  if (!rows || rows.length === 0) return null;
  return rows[0] ?? null;
}
