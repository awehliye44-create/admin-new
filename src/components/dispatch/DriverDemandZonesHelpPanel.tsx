import {
  Train,
  ShoppingBag,
  Hospital,
  Trophy,
  Plane,
  Music,
  Info,
} from 'lucide-react';
import {
  buildDemandZoneColorPalette,
  buildDemandLegendItems,
} from '@/lib/demandZoneMapStyle';
import type { DemandLevel, DemandZoneSettings } from '../../../shared/demandZoneSurgeSSOT';
import { DEMAND_ZONE_SETTINGS_DEFAULTS } from '../../../shared/demandZoneSurgeSSOT';

const BEST_USE_CASES = [
  { label: 'Train stations', icon: Train },
  { label: 'Shopping centres', icon: ShoppingBag },
  { label: 'Hospitals', icon: Hospital },
  { label: 'Stadiums', icon: Trophy },
  { label: 'Airport pickup areas', icon: Plane },
  { label: 'Nightlife areas', icon: Music },
] as const;

type SettingsSlice = Pick<
  DemandZoneSettings,
  | 'low_min_trips'
  | 'low_max_trips'
  | 'medium_min_trips'
  | 'medium_max_trips'
  | 'high_min_trips'
  | 'open_trip_max_lifetime_minutes'
  | 'recompute_interval_minutes'
  | 'consecutive_checks_required'
  | 'surge_enabled'
  | 'multiplier_low'
  | 'multiplier_medium'
  | 'multiplier_high'
  | 'colour_low'
  | 'colour_medium'
  | 'colour_high'
>;

interface Props {
  settings?: SettingsSlice | null;
}

function thresholdLabel(settings: SettingsSlice, level: DemandLevel): string {
  if (level === 'LOW') {
    return `${settings.low_min_trips}–${settings.low_max_trips} open trip(s)`;
  }
  if (level === 'MEDIUM') {
    return `${settings.medium_min_trips}–${settings.medium_max_trips} open trips`;
  }
  return `${settings.high_min_trips}+ open trips`;
}

export function DriverDemandZonesHelpPanel({ settings }: Props) {
  const effective = settings ?? DEMAND_ZONE_SETTINGS_DEFAULTS;
  const palette = buildDemandZoneColorPalette(effective);
  const legend = buildDemandLegendItems(palette);

  return (
    <aside className="flex flex-col gap-4 rounded-lg border bg-card p-4 text-sm">
      <div className="flex items-center gap-2">
        <Info className="h-4 w-4 text-primary shrink-0" />
        <h2 className="font-semibold text-foreground">About Driver Demand Zones</h2>
      </div>

      <p className="text-muted-foreground leading-relaxed">
        Driver Demand Zones show drivers where unassigned trip demand is building. Computed zones
        use the thresholds and timing from Heat map &amp; surge settings for each service area.
      </p>

      <section>
        <h3 className="font-medium text-foreground mb-1">How it works</h3>
        <ul className="list-disc space-y-1 pl-4 text-muted-foreground text-xs">
          <li>
            <strong className="text-foreground">Computed zones</strong> bucket open, unassigned
            trips within the last {effective.open_trip_max_lifetime_minutes} minutes.
          </li>
          <li>
            Levels must match for {effective.consecutive_checks_required} consecutive recompute
            run(s) before the confirmed level changes (hysteresis).
          </li>
          <li>
            Cron and the manual button refresh every {effective.recompute_interval_minutes}{' '}
            minute{effective.recompute_interval_minutes === 1 ? '' : 's'} (when heat map is enabled).
          </li>
          <li>
            <strong className="text-foreground">Manual zones</strong> are admin-created and are not
            overwritten by recompute (when manual zones are enabled for the service area).
          </li>
        </ul>
      </section>

      <section>
        <h3 className="font-medium text-foreground mb-2">Demand levels</h3>
        <div className="space-y-2">
          {legend.map(({ level, label, fill, stroke }) => (
            <div key={level} className="flex items-start gap-2 text-xs">
              <span
                className="mt-0.5 h-3.5 w-3.5 rounded-full border shrink-0"
                style={{ backgroundColor: fill, borderColor: stroke }}
                aria-hidden
              />
              <div>
                <span className="font-medium text-foreground">{label}</span>
                <span className="text-muted-foreground">
                  {' — '}
                  {thresholdLabel(effective, level as DemandLevel)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {effective.surge_enabled && (
        <div className="rounded-md border border-amber-200/60 bg-amber-50/80 dark:border-amber-900/40 dark:bg-amber-950/30 p-3">
          <p className="font-medium text-foreground text-xs uppercase tracking-wide mb-1">
            Zone surge active
          </p>
          <p className="text-muted-foreground text-xs mb-2">
            Confirmed demand at pickup applies these multipliers to metered fares only.
          </p>
          <ul className="text-xs text-muted-foreground space-y-0.5">
            <li>Low — ×{effective.multiplier_low ?? 1}</li>
            {effective.multiplier_medium != null && (
              <li>Medium — ×{effective.multiplier_medium}</li>
            )}
            {effective.multiplier_high != null && (
              <li>High — ×{effective.multiplier_high}</li>
            )}
          </ul>
        </div>
      )}

      <section>
        <h3 className="font-medium text-foreground mb-2">Best use cases</h3>
        <ul className="grid gap-1.5">
          {BEST_USE_CASES.map(({ label, icon: Icon }) => (
            <li key={label} className="flex items-center gap-2 text-xs text-muted-foreground">
              <Icon className="h-3.5 w-3.5 text-primary shrink-0" />
              {label}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="font-medium text-foreground mb-1">Hierarchy</h3>
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Region</span>
          {' → '}
          <span className="font-medium text-foreground">Service Area</span>
          {' → '}
          <span className="font-medium text-foreground">Demand Zone</span>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Drivers only see zones scoped to their region and service area (or global zones with no scope).
        </p>
      </section>
    </aside>
  );
}
