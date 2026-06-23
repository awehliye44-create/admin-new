/** ONECAB driver demand colours — must match drive-hub-buddy demandZoneStyle.ts */
export type DemandLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export const DEMAND_ZONE_COLORS: Record<
  DemandLevel,
  { fill: string; stroke: string; label: string; fillOpacity: number; strokeOpacity: number }
> = {
  HIGH: {
    fill: '#FF5722',
    stroke: '#E64A19',
    label: 'High demand',
    fillOpacity: 0.38,
    strokeOpacity: 0.72,
  },
  MEDIUM: {
    fill: '#FFC107',
    stroke: '#FFA000',
    label: 'Medium demand',
    fillOpacity: 0.28,
    strokeOpacity: 0.55,
  },
  LOW: {
    fill: '#64B5F6',
    stroke: '#42A5F5',
    label: 'Low demand',
    fillOpacity: 0.18,
    strokeOpacity: 0.45,
  },
};

export const DEMAND_LEGEND_ITEMS = (
  Object.entries(DEMAND_ZONE_COLORS) as Array<[DemandLevel, (typeof DEMAND_ZONE_COLORS)[DemandLevel]]>
).map(([level, colors]) => ({
  level,
  label: colors.label,
  fill: colors.fill,
  stroke: colors.stroke,
}));
