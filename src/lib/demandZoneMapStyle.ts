import {
  DEFAULT_LEVEL_COLOURS,
  LEVEL_OPACITY,
  levelColour,
  type DemandLevel,
  type DemandZoneSettings,
} from '../../shared/demandZoneSurgeSSOT';

export type { DemandLevel };

export interface DemandZoneColorEntry {
  fill: string;
  stroke: string;
  label: string;
  fillOpacity: number;
  strokeOpacity: number;
}

const LEVEL_LABELS: Record<DemandLevel, string> = {
  LOW: 'Low demand',
  MEDIUM: 'Medium demand',
  HIGH: 'High demand',
};

/** Build map fill/stroke palette from per-SA settings (or SSOT defaults). */
export function buildDemandZoneColorPalette(
  settings?: Pick<DemandZoneSettings, 'colour_low' | 'colour_medium' | 'colour_high'> | null,
): Record<DemandLevel, DemandZoneColorEntry> {
  return {
    LOW: paletteEntry('LOW', settings),
    MEDIUM: paletteEntry('MEDIUM', settings),
    HIGH: paletteEntry('HIGH', settings),
  };
}

function paletteEntry(
  level: DemandLevel,
  settings?: Pick<DemandZoneSettings, 'colour_low' | 'colour_medium' | 'colour_high'> | null,
): DemandZoneColorEntry {
  const fill = levelColour(settings, level);
  const opacity = LEVEL_OPACITY[level];
  return {
    fill,
    stroke: fill,
    label: LEVEL_LABELS[level],
    fillOpacity: opacity.fill,
    strokeOpacity: opacity.stroke,
  };
}

/** Default palette — matches SSOT default colours. */
export const DEMAND_ZONE_COLORS = buildDemandZoneColorPalette({
  colour_low: DEFAULT_LEVEL_COLOURS.LOW,
  colour_medium: DEFAULT_LEVEL_COLOURS.MEDIUM,
  colour_high: DEFAULT_LEVEL_COLOURS.HIGH,
});

export function buildDemandLegendItems(
  palette: Record<DemandLevel, DemandZoneColorEntry> = DEMAND_ZONE_COLORS,
) {
  return (Object.entries(palette) as Array<[DemandLevel, DemandZoneColorEntry]>).map(
    ([level, colors]) => ({
      level,
      label: colors.label,
      fill: colors.fill,
      stroke: colors.stroke,
    }),
  );
}

export const DEMAND_LEGEND_ITEMS = buildDemandLegendItems();
