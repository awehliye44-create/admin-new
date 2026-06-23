import { Info, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

type StackedRidesHelpPanelProps = {
  stackedRidesEnabled: boolean;
  stackedSearchRadiusMeters: number;
  stackedMinTripDistanceKm: number;
  stackedOfferWindowMinutes: number;
  stackedMaxDetourMinutes: number;
  maxStackedRides: number;
  unitShort: string;
  fromKm: (km: number) => number;
};

const REJECTION_REASONS: { code: string; meaning: string }[] = [
  { code: 'stacked_new_trip_too_short', meaning: 'New trip distance is below Minimum Trip Distance.' },
  { code: 'stacked_outside_search_radius', meaning: 'New pickup is too far from the driver AND from the active trip dropoff.' },
  { code: 'stacked_not_within_offer_window', meaning: 'Active trip has more remaining time than the Offer Window allows.' },
  { code: 'stacked_detour_too_long', meaning: 'Estimated drive from driver to new pickup exceeds Max Detour Time.' },
  { code: 'stacked_already_has_queued_trip', meaning: 'Driver already has a queued stacked trip on the current ride.' },
  { code: 'stacked_max_concurrent_reached', meaning: 'Driver already has the maximum pending stacked offers.' },
  { code: 'stacked_driver_offline', meaning: 'Driver is not online or presence is stale.' },
  { code: 'stacked_heading_to_pickup_blocked', meaning: 'Current trip is still accepted (heading to pickup) — not yet in progress.' },
  { code: 'stacked_pickup_waiting_blocked', meaning: 'Driver is waiting at pickup and Stack During Pickup Waiting is off.' },
  { code: 'stacked_stop_waiting_blocked', meaning: 'Driver is in paid stop waiting and Stack During Stop Waiting is off.' },
  { code: 'stacked_airport_blocked', meaning: 'New trip is an airport job and Allow Airport Stacking is off.' },
  { code: 'stacked_scheduled_blocked', meaning: 'New trip is scheduled/prebook and Allow Scheduled Stacking is off.' },
  { code: 'stacked_service_area_mismatch', meaning: 'Driver is not mapped to the new trip service area.' },
  { code: 'stacked_region_mismatch', meaning: 'Driver region does not match the new trip region.' },
];

export function StackedRidesHelpPanel({
  stackedRidesEnabled,
  stackedSearchRadiusMeters,
  stackedMinTripDistanceKm,
  stackedOfferWindowMinutes,
  stackedMaxDetourMinutes,
  maxStackedRides,
  unitShort,
  fromKm,
}: StackedRidesHelpPanelProps) {
  const radiusDisplay = `${stackedSearchRadiusMeters.toLocaleString()} m (${fromKm(stackedSearchRadiusMeters / 1000).toFixed(2)} ${unitShort})`;
  const minDistanceDisplay = `${fromKm(stackedMinTripDistanceKm).toFixed(2)} ${unitShort}`;

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
        <Info className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
        <div className="text-sm text-blue-700 dark:text-blue-400 space-y-2">
          <p className="font-medium text-blue-800 dark:text-blue-300">What are stacked rides?</p>
          <p>
            A driver on an <strong>active trip (Trip A)</strong> can receive a <strong>stacked offer</strong> for a
            second booking (Trip B). If they accept, Trip B is <strong>queued</strong> — it does not start immediately.
            When Trip A completes, Trip B is promoted automatically and becomes the driver&apos;s next active ride.
          </p>
          <p className="text-xs">
            Settings on this page are saved to <code className="text-xs">global_dispatch_settings</code> and read by
            the auto-dispatch edge function. Legacy <code className="text-xs">dispatch_settings</code> columns are not
            used for stacked matching.
          </p>
        </div>
      </div>

      {!stackedRidesEnabled && (
        <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
          <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <p className="text-sm text-amber-700 dark:text-amber-400">
            Stacked rides are <strong>disabled</strong>. No stacked offers will be sent until you enable the toggle above
            and save.
          </p>
        </div>
      )}

      <div>
        <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-primary" />
          When does a busy driver get a stacked offer?
        </h4>
        <p className="text-sm text-muted-foreground mb-3">
          Auto-dispatch checks <strong>busy drivers only</strong> (drivers with an active <code>current_trip_id</code>).
          All conditions below must pass — checks run in this order:
        </p>
        <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">Stacked rides enabled</span> — master toggle on this page.
          </li>
          <li>
            <span className="font-medium text-foreground">Driver online &amp; approved</span> — live presence heartbeat;
            stale location blocks the offer.
          </li>
          <li>
            <span className="font-medium text-foreground">New trip minimum distance</span> — currently{' '}
            <Badge variant="outline" className="text-xs align-middle">{minDistanceDisplay}</Badge>. Shorter trips are
            rejected as <code>stacked_new_trip_too_short</code>.
          </li>
          <li>
            <span className="font-medium text-foreground">Trip type gates</span> — airport / scheduled stacking only if
            the matching toggles on the Matching Rules tab are on (default off).
          </li>
          <li>
            <span className="font-medium text-foreground">No existing queued trip</span> — driver cannot stack more than{' '}
            <Badge variant="outline" className="text-xs align-middle">{maxStackedRides}</Badge> queued ride(s) on Trip A.
          </li>
          <li>
            <span className="font-medium text-foreground">Active trip phase</span> — default: status must be{' '}
            <code>in_progress</code> (passenger onboard). Optional: allow stacking while <code>arrived</code> at pickup
            if &quot;Stack During Pickup Waiting&quot; is on. Trips still heading to pickup (<code>accepted</code>) never
            stack.
          </li>
          <li>
            <span className="font-medium text-foreground">Offer window</span> — only in the last{' '}
            <Badge variant="outline" className="text-xs align-middle">{stackedOfferWindowMinutes} min</Badge> of the
            estimated trip duration (from <code>started_at</code> + <code>estimated_duration_minutes</code>).
          </li>
          <li>
            <span className="font-medium text-foreground">Service area &amp; region</span> — driver must serve the new
            trip&apos;s area.
          </li>
          <li>
            <span className="font-medium text-foreground">Search radius (primary gate)</span> — new pickup within{' '}
            <Badge variant="outline" className="text-xs align-middle">{radiusDisplay}</Badge> of the driver&apos;s live
            position <strong>or</strong> Trip A&apos;s dropoff. Direction/bearing is <strong>not</strong> used.
          </li>
          <li>
            <span className="font-medium text-foreground">Max detour time</span> — estimated minutes from driver to new
            pickup must be ≤{' '}
            <Badge variant="outline" className="text-xs align-middle">{stackedMaxDetourMinutes} min</Badge> (~2 min per km
            urban estimate).
          </li>
          <li>
            <span className="font-medium text-foreground">Presence quality</span> — valid GPS, heartbeat, and push token
            for offer delivery.
          </li>
        </ol>
      </div>

      <div>
        <h4 className="text-sm font-semibold mb-3">After the driver accepts</h4>
        <ul className="list-disc list-inside space-y-1.5 text-sm text-muted-foreground">
          <li>Trip B moves to <code>queued</code> status and links to Trip A via <code>stacked_trip_id</code>.</li>
          <li>Trip A continues normally — the driver keeps navigating the current ride.</li>
          <li>When Trip A completes, Trip B is <strong>promoted</strong> to the driver&apos;s active trip automatically.</li>
          <li>
            If the driver goes <strong>offline during Trip A</strong>, the queued Trip B is cancelled or re-dispatched
            (reason: <code>stacked_current_trip_driver_offline</code>). Drivers must stay online through accept and
            completion.
          </li>
          <li>Stacked offers disable fare negotiation — accept or decline only.</li>
        </ul>
      </div>

      <div>
        <h4 className="text-sm font-semibold mb-3">Settings → backend mapping</h4>
        <div className="rounded-lg border overflow-hidden text-sm">
          <table className="w-full">
            <thead>
              <tr className="bg-muted/50 text-left">
                <th className="px-3 py-2 font-medium">Admin field</th>
                <th className="px-3 py-2 font-medium">Effect</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              <tr>
                <td className="px-3 py-2 text-muted-foreground">Stacked Rides toggle</td>
                <td className="px-3 py-2">Master on/off — edge returns zero stacked offers when off.</td>
              </tr>
              <tr>
                <td className="px-3 py-2 text-muted-foreground">Max Stacked Rides</td>
                <td className="px-3 py-2">Cap on queued trips and concurrent pending stacked offers per driver.</td>
              </tr>
              <tr>
                <td className="px-3 py-2 text-muted-foreground">Stacked Search Radius</td>
                <td className="px-3 py-2">Max straight-line distance from driver or active dropoff to new pickup.</td>
              </tr>
              <tr>
                <td className="px-3 py-2 text-muted-foreground">Offer Window</td>
                <td className="px-3 py-2">Minutes before estimated trip end when stacking is allowed.</td>
              </tr>
              <tr>
                <td className="px-3 py-2 text-muted-foreground">Minimum Trip Distance</td>
                <td className="px-3 py-2">Shortest new booking eligible for stacking.</td>
              </tr>
              <tr>
                <td className="px-3 py-2 text-muted-foreground">Max Detour Time</td>
                <td className="px-3 py-2">Max estimated drive time from driver location to new pickup.</td>
              </tr>
              <tr>
                <td className="px-3 py-2 text-muted-foreground">Pickup / stop waiting toggles</td>
                <td className="px-3 py-2">Allow offers while driver waits at pickup or during multi-stop waiting.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h4 className="text-sm font-semibold mb-3">Troubleshooting — common rejection reasons</h4>
        <p className="text-sm text-muted-foreground mb-3">
          Each failed check is logged in <code>dispatch_eligibility_log</code> with{' '}
          <code>stacked_gate: true</code>. Use Booking Delivery Admin or SQL to inspect a specific driver/trip pair.
        </p>
        <div className="rounded-lg border divide-y text-sm max-h-64 overflow-y-auto">
          {REJECTION_REASONS.map((row) => (
            <div key={row.code} className="px-3 py-2 flex flex-col sm:flex-row sm:gap-3">
              <code className="text-xs shrink-0 text-primary">{row.code}</code>
              <span className="text-muted-foreground">{row.meaning}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-start gap-2 p-3 bg-muted/50 rounded-lg">
        <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
        <div className="text-sm text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">Testing tip</p>
          <p>
            Book a test ride whose pickup is within the search radius of the driver&apos;s <strong>current dropoff</strong>{' '}
            while they are in the last {stackedOfferWindowMinutes} minutes of Trip A. Increasing search radius (e.g. 4000–5000 m)
            helps in spread-out areas; lowering minimum trip distance allows shorter stacked jobs.
          </p>
        </div>
      </div>
    </div>
  );
}
