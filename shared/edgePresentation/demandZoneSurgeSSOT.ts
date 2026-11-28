/** Admin presentation-only helpers; not part of Edge uploads. */
import { DemandLevel, DemandZoneSettings, DEFAULT_LEVEL_COLOURS, isValidHexColour, normaliseHexColour, ValidationResult, validateThresholds, validateColours, validateSurge, DemandZoneActionKey, ALL_SERVICE_AREAS } from "../../supabase/functions/_shared/demandZoneSurgeSSOT.ts";


export const DEMAND_LEVELS: DemandLevel[] = ['LOW', 'MEDIUM', 'HIGH'];


/** Presentation-only fill/stroke opacity per level. */
export const LEVEL_OPACITY: Record<DemandLevel, { fill: number; stroke: number }> = {
  LOW: { fill: 0.18, stroke: 0.45 },
  MEDIUM: { fill: 0.28, stroke: 0.55 },
  HIGH: { fill: 0.38, stroke: 0.72 },
};


export function levelColour(settings: Pick<DemandZoneSettings, 'colour_low' | 'colour_medium' | 'colour_high'> | null | undefined, level: DemandLevel): string {
  if (!settings) return DEFAULT_LEVEL_COLOURS[level];
  const raw =
    level === 'HIGH' ? settings.colour_high : level === 'MEDIUM' ? settings.colour_medium : settings.colour_low;
  return isValidHexColour(raw) ? normaliseHexColour(raw) : DEFAULT_LEVEL_COLOURS[level];
}


export function validateDemandZoneSettings(s: Omit<DemandZoneSettings, 'service_area_id'> & { service_area_id?: string }): ValidationResult {
  const errors = [
    ...validateThresholds(s).errors,
    ...validateColours(s).errors,
    ...validateSurge(s).errors,
  ];
  if (!s.service_area_id) errors.push('SERVICE_AREA_REQUIRED');
  return { valid: errors.length === 0, errors };
}


export const ALL_SERVICE_AREAS_MESSAGE =
  'Select one service area to configure heat-map and surge settings.';


export function canConfigureForSelection(params: {
  selectedServiceAreaId: string;
  isSuperAdmin: boolean;
  allowedActions: string[];
  actionKey: DemandZoneActionKey;
}): boolean {
  if (params.selectedServiceAreaId === ALL_SERVICE_AREAS || !params.selectedServiceAreaId) return false;
  if (params.isSuperAdmin) return true;
  return params.allowedActions.includes(params.actionKey);
}

export * from "../../supabase/functions/_shared/demandZoneSurgeSSOT.ts";
