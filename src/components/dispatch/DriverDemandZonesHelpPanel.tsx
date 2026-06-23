import {
  Train,
  ShoppingBag,
  Hospital,
  Trophy,
  Plane,
  Music,
  CheckCircle2,
  Info,
} from 'lucide-react';
import { DEMAND_ZONE_COLORS } from '@/lib/demandZoneMapStyle';

const NO_IMPACT_ITEMS = [
  'Fares',
  'Dispatch',
  'Driver priority',
  'Customer prices',
  'Commissions',
  'Earnings',
] as const;

const BEST_USE_CASES = [
  { label: 'Train stations', icon: Train },
  { label: 'Shopping centres', icon: ShoppingBag },
  { label: 'Hospitals', icon: Hospital },
  { label: 'Stadiums', icon: Trophy },
  { label: 'Airport pickup areas', icon: Plane },
  { label: 'Nightlife areas', icon: Music },
] as const;

export function DriverDemandZonesHelpPanel() {
  return (
    <aside className="flex flex-col gap-4 rounded-lg border bg-card p-4 text-sm">
      <div className="flex items-center gap-2">
        <Info className="h-4 w-4 text-primary shrink-0" />
        <h2 className="font-semibold text-foreground">About Driver Demand Zones</h2>
      </div>

      <p className="text-muted-foreground leading-relaxed">
        Driver Demand Zones provide visual guidance to drivers about areas of higher and lower
        activity. They help drivers position themselves more effectively on the map.
      </p>

      <div className="rounded-md border border-blue-200/60 bg-blue-50/80 dark:border-blue-900/40 dark:bg-blue-950/30 p-3">
        <p className="font-medium text-foreground text-xs uppercase tracking-wide mb-2">
          Important: Advisory only
        </p>
        <p className="text-muted-foreground text-xs mb-2">
          Demand zones do <strong className="text-foreground">not</strong> impact:
        </p>
        <ul className="space-y-1">
          {NO_IMPACT_ITEMS.map((item) => (
            <li key={item} className="flex items-center gap-2 text-xs text-muted-foreground">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
              {item}
            </li>
          ))}
        </ul>
      </div>

      <section>
        <h3 className="font-medium text-foreground mb-1">How it works</h3>
        <ul className="list-disc space-y-1 pl-4 text-muted-foreground text-xs">
          <li>
            <strong className="text-foreground">Computed zones</strong> are generated from open
            unassigned trips from the last 45 minutes.
          </li>
          <li>Zones refresh automatically every 2 minutes.</li>
          <li>
            <strong className="text-foreground">Manual zones</strong> are admin-created overrides
            and are not deleted by recompute.
          </li>
        </ul>
      </section>

      <section>
        <h3 className="font-medium text-foreground mb-2">Demand levels</h3>
        <div className="space-y-2">
          {(Object.entries(DEMAND_ZONE_COLORS) as Array<
            [keyof typeof DEMAND_ZONE_COLORS, (typeof DEMAND_ZONE_COLORS)[keyof typeof DEMAND_ZONE_COLORS]]
          >).map(([level, colors]) => (
            <div key={level} className="flex items-start gap-2 text-xs">
              <span
                className="mt-0.5 h-3.5 w-3.5 rounded-full border shrink-0"
                style={{ backgroundColor: colors.fill, borderColor: colors.stroke }}
                aria-hidden
              />
              <div>
                <span className="font-medium text-foreground">{colors.label}</span>
                <span className="text-muted-foreground">
                  {' — '}
                  {level === 'HIGH' && '4+ open trips in cell'}
                  {level === 'MEDIUM' && '2–3 open trips'}
                  {level === 'LOW' && '1 open trip'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

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
