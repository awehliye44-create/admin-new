import { describe, expect, it } from 'vitest';
import { DEMAND_ZONE_SETTINGS_DEFAULTS } from '../../../shared/demandZoneSurgeSSOT';
import {
  buildDemandZoneSettingsSavePayload,
  demandZoneSettingsFormsEqual,
  mapDemandZoneSettingsRowToForm,
  safeHexColourForDisplay,
  serverSettingsAreNewerThanBaseline,
  shouldRehydrateDemandZoneSettingsForm,
  starterDemandZoneSettingsForm,
  verifyDemandZoneSettingsSaved,
} from '../demandZoneSettingsForm';

describe('safeHexColourForDisplay', () => {
  it('never throws on incomplete or invalid hex drafts', () => {
    expect(() => safeHexColourForDisplay('#FF', '#22C55E')).not.toThrow();
    expect(() => safeHexColourForDisplay('not-a-colour', '#22C55E')).not.toThrow();
    expect(() => safeHexColourForDisplay('', '#22C55E')).not.toThrow();
    expect(() => safeHexColourForDisplay(null, '#22C55E')).not.toThrow();
    expect(safeHexColourForDisplay('#FF', '#22C55E')).toBe('#22C55E');
    expect(safeHexColourForDisplay('#ABCDEF', '#22C55E')).toBe('#ABCDEF');
  });
});

describe('mapDemandZoneSettingsRowToForm', () => {
  it('coerces jsonb numeric strings so multipliers like 1.15 persist', () => {
    const mapped = mapDemandZoneSettingsRowToForm({
      ...DEMAND_ZONE_SETTINGS_DEFAULTS,
      multiplier_low: '1.15' as unknown as number,
      multiplier_medium: '1.25' as unknown as number,
      multiplier_high: '1.5' as unknown as number,
      max_multiplier: '2' as unknown as number,
      zone_radius_meters: '700' as unknown as number,
      surge_enabled: 'true' as unknown as boolean,
    });
    expect(mapped.multiplier_low).toBe(1.15);
    expect(mapped.multiplier_medium).toBe(1.25);
    expect(mapped.multiplier_high).toBe(1.5);
    expect(mapped.max_multiplier).toBe(2);
    expect(mapped.zone_radius_meters).toBe(700);
    expect(mapped.surge_enabled).toBe(true);
  });

  it('does not invent a successful row when mapping empty input beyond starters', () => {
    const starters = starterDemandZoneSettingsForm();
    const mapped = mapDemandZoneSettingsRowToForm({});
    expect(demandZoneSettingsFormsEqual(mapped, starters)).toBe(true);
  });
});

describe('verifyDemandZoneSettingsSaved', () => {
  it('verifies all edited fields, not only surge_enabled', () => {
    const submitted = {
      ...starterDemandZoneSettingsForm(),
      colour_low: '#111111',
      colour_medium: '#222222',
      colour_high: '#333333',
      zone_radius_meters: 800,
      recompute_interval_minutes: 3,
      open_trip_max_lifetime_minutes: 9,
      consecutive_checks_required: 3,
      surge_enabled: true,
      multiplier_low: 1.15,
      multiplier_medium: 1.25,
      multiplier_high: 1.4,
      max_multiplier: 2,
    };

    expect(verifyDemandZoneSettingsSaved(submitted, { ...submitted })).toEqual([]);

    expect(
      verifyDemandZoneSettingsSaved(submitted, {
        ...submitted,
        surge_enabled: true,
        colour_low: '#FFFFFF',
      }),
    ).toEqual(['colour_low']);

    expect(
      verifyDemandZoneSettingsSaved(submitted, {
        ...submitted,
        surge_enabled: true,
        multiplier_low: 1.1,
      }),
    ).toEqual(['multiplier_low']);

    expect(
      verifyDemandZoneSettingsSaved(submitted, {
        ...submitted,
        zone_radius_meters: 700,
      }),
    ).toEqual(['zone_radius_meters']);

    expect(verifyDemandZoneSettingsSaved(submitted, null)).toContain('surge_enabled');
    expect(verifyDemandZoneSettingsSaved(submitted, null)).toContain('colour_high');
  });

  it('treats normalised hex as equal', () => {
    const submitted = {
      ...starterDemandZoneSettingsForm(),
      colour_low: '#22c55e',
    };
    expect(
      verifyDemandZoneSettingsSaved(submitted, {
        ...submitted,
        colour_low: '#22C55E',
      }),
    ).toEqual([]);
  });
});

describe('hydration / dirty refetch policy', () => {
  it('does not rehydrate dirty forms over newer server data', () => {
    const baseline = starterDemandZoneSettingsForm();
    const incoming = { ...baseline, zone_radius_meters: 900 };
    expect(
      shouldRehydrateDemandZoneSettingsForm({
        loadStatus: 'ready',
        formDirty: true,
        baseline,
        incoming,
      }),
    ).toBe(false);
    expect(
      serverSettingsAreNewerThanBaseline({
        baseline,
        incoming,
        formDirty: true,
      }),
    ).toBe(true);
  });

  it('allows clean forms to adopt server data', () => {
    const baseline = starterDemandZoneSettingsForm();
    const incoming = { ...baseline, zone_radius_meters: 900 };
    expect(
      shouldRehydrateDemandZoneSettingsForm({
        loadStatus: 'ready',
        formDirty: false,
        baseline,
        incoming,
      }),
    ).toBe(true);
  });

  it('does not rehydrate while load is error/loading/missing', () => {
    const baseline = starterDemandZoneSettingsForm();
    for (const loadStatus of ['error', 'loading', 'missing', 'idle'] as const) {
      expect(
        shouldRehydrateDemandZoneSettingsForm({
          loadStatus,
          formDirty: false,
          baseline,
          incoming: baseline,
        }),
      ).toBe(false);
    }
  });
});

describe('buildDemandZoneSettingsSavePayload', () => {
  it('normalises valid colours and keeps numeric multipliers', () => {
    const payload = buildDemandZoneSettingsSavePayload({
      ...starterDemandZoneSettingsForm(),
      colour_low: '#22c55e',
      multiplier_low: 1.15,
      surge_enabled: true,
      multiplier_medium: 1.2,
      multiplier_high: 1.3,
    });
    expect(payload.colour_low).toBe('#22C55E');
    expect(payload.multiplier_low).toBe(1.15);
    expect(payload.surge_enabled).toBe(true);
  });
});
