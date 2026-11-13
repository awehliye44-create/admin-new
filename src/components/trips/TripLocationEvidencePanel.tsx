import { format } from 'date-fns';
import { AlertTriangle, ExternalLink, Loader2, ShieldCheck } from 'lucide-react';
import {
  EVIDENCE_ACTION_META,
  PASSENGER_MARKER_COLOR,
  evidenceFreshness,
  formatEvidenceAge,
  formatEvidenceDistance,
  googleMapsPointUrl,
  type TripLocationEvidence,
} from '@/lib/tripLocationEvidence';

type Props = {
  evidence: TripLocationEvidence[] | undefined;
  isLoading: boolean;
  error: Error | null;
};

const fmtTime = (iso: string | null) => (iso ? format(new Date(iso), 'dd MMM yyyy, HH:mm:ss') : '—');
const fmtCoord = (lat: number, lng: number) => `${lat.toFixed(6)}, ${lng.toFixed(6)}`;

function Dot({ color, label }: { color: string; label?: string }) {
  return (
    <span
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-background text-[10px] font-bold text-primary-foreground shadow"
      style={{ background: color }}
    >
      {label}
    </span>
  );
}

export function TripLocationEvidencePanel({ evidence, isLoading, error }: Props) {
  return (
    <div className="space-y-2" data-testid="trip-location-evidence">
      <h4 className="text-sm font-semibold flex items-center gap-2">
        <ShieldCheck className="h-4 w-4" />
        Location proof
      </h4>

      {isLoading && (
        <p className="flex items-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading location proof…
        </p>
      )}

      {error && (
        <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error.message}
        </div>
      )}

      {!isLoading && !error && (evidence?.length ?? 0) === 0 && (
        <p className="text-sm text-muted-foreground">
          No location proof was recorded for this trip. Proof is saved for taps made from 13 Nov 2026 onwards.
        </p>
      )}

      {evidence?.map((row) => {
        const meta = EVIDENCE_ACTION_META[row.action];
        const freshness = evidenceFreshness(row);
        return (
          <div key={row.id} className="rounded-md border border-border p-3 space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <Dot color={meta.color} label={meta.marker} />
              <p className="font-medium">{meta.label}</p>
              <span className="ml-auto text-xs text-muted-foreground">{fmtTime(row.recorded_at)}</span>
            </div>

            {freshness === 'missing' ? (
              <p className="flex items-center gap-1 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" /> The driver's phone had not sent a location at this moment.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                <div>
                  <p className="text-xs text-muted-foreground">Driver position</p>
                  <a
                    href={googleMapsPointUrl(row.driver_lat!, row.driver_lng!)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
                  >
                    {fmtCoord(row.driver_lat!, row.driver_lng!)} <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Distance from {meta.targetLabel}</p>
                  <p className="font-medium">{formatEvidenceDistance(row.distance_to_target_m)}</p>
                </div>
                <div className="sm:col-span-2">
                  <p className="text-xs text-muted-foreground">
                    GPS reading taken {fmtTime(row.driver_location_at)} ({formatEvidenceAge(row.driver_location_age_seconds)})
                    {row.driver_accuracy_m != null && ` · accurate to ±${Math.round(row.driver_accuracy_m)} m`}
                  </p>
                  {freshness === 'stale' && (
                    <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
                      <AlertTriangle className="h-3.5 w-3.5" /> This GPS reading is more than 2 minutes old, so the driver may have moved.
                    </p>
                  )}
                </div>
              </div>
            )}

            <div className="flex items-start gap-2 border-t border-border pt-2">
              <Dot color={PASSENGER_MARKER_COLOR} label="P" />
              {row.passenger_lat != null && row.passenger_lng != null ? (
                <div>
                  <p className="text-xs text-muted-foreground">Passenger's shared location</p>
                  <a
                    href={googleMapsPointUrl(row.passenger_lat, row.passenger_lng)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
                  >
                    {fmtCoord(row.passenger_lat, row.passenger_lng)} <ExternalLink className="h-3 w-3" />
                  </a>
                  <p className="text-xs text-muted-foreground">
                    Updated {fmtTime(row.passenger_location_at)}
                    {row.passenger_accuracy_m != null && ` · ±${Math.round(row.passenger_accuracy_m)} m`}
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">The passenger was not sharing their location.</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
