import { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Calculator, RotateCcw, AlertCircle } from 'lucide-react';

interface DistanceBand {
  from: number;
  to: number | null;
  rate_pence: number;
}

interface FareSettings {
  pricing_mode: string;
  base_fare_pence: number;
  per_km_rate_pence: number;
  per_min_rate_pence: number;
  booking_fee_pence: number;
  minimum_fare_pence: number;
  free_waiting_minutes: number;
  waiting_per_minute_pence: number;
  extra_stop_flat_fee_pence: number;
  recalculate_on_waiting: boolean;
  recalculate_on_stop_added: boolean;
  recalculate_on_dropoff_changed: boolean;
  enable_surge: boolean;
  surge_multiplier_default: number;
  zone_multiplier: number;
  traffic_multiplier: number;
  distance_pricing_bands?: DistanceBand[] | null;
}

const KM_PER_MILE = 1.609344;

interface BandSegment {
  from: number;
  to: number | null;
  span: number;
  rate_pence: number;
  charge_pence: number;
}

function tieredBreakdown(distInUnit: number, bands: DistanceBand[]): { total: number; segments: BandSegment[] } {
  const sorted = [...bands].sort((a, b) => (a.from ?? 0) - (b.from ?? 0));
  const segments: BandSegment[] = [];
  let total = 0;
  for (const b of sorted) {
    const upper = b.to == null ? Infinity : b.to;
    const span = Math.max(0, Math.min(distInUnit, upper) - (b.from ?? 0));
    if (span > 0) {
      const charge = Math.round(span * (b.rate_pence ?? 0));
      total += charge;
      segments.push({ from: b.from ?? 0, to: b.to, span, rate_pence: b.rate_pence ?? 0, charge_pence: charge });
    }
  }
  return { total, segments };
}

interface FareSimulatorCardProps {
  settings: FareSettings;
  currencySymbol: string;
  distanceUnit?: string;
}

export function FareSimulatorCard({ settings, currencySymbol, distanceUnit }: FareSimulatorCardProps) {
  const isMiles = (distanceUnit || 'mile').toLowerCase().startsWith('mi');
  const unitShort = isMiles ? 'mi' : 'km';
  const [distKm, setDistKm] = useState(8);
  const [durMin, setDurMin] = useState(15);
  const [waitMin, setWaitMin] = useState(0);
  const [stops, setStops] = useState(0);
  const [showResult, setShowResult] = useState(false);

  const resultRef = useRef<HTMLDivElement>(null);

  const calculate = () => {
    setShowResult(true);
    requestAnimationFrame(() => {
      resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };

  const reset = () => {
    setDistKm(8);
    setDurMin(15);
    setWaitMin(0);
    setStops(0);
    setShowResult(false);
  };

  // Compute fare
  const base = settings.base_fare_pence;
  const bands = settings.distance_pricing_bands ?? [];
  const bandResult = bands.length > 0 ? tieredBreakdown(distKm, bands) : null;
  const distCharge = bandResult
    ? bandResult.total
    : Math.round(distKm * settings.per_km_rate_pence);
  const timeCharge = Math.round(durMin * settings.per_min_rate_pence);
  const booking = settings.booking_fee_pence;

  let subtotal = base + distCharge + timeCharge + booking;

  if (settings.pricing_mode === 'dynamic' && settings.enable_surge) {
    const multiplier = settings.surge_multiplier_default * settings.zone_multiplier * settings.traffic_multiplier;
    subtotal = Math.round((base + distCharge + timeCharge) * multiplier) + booking;
  }

  const quotedFare = Math.max(subtotal, settings.minimum_fare_pence);

  const billableWait = Math.max(0, waitMin - settings.free_waiting_minutes);
  const waitingCharge = settings.recalculate_on_waiting
    ? Math.round(billableWait * settings.waiting_per_minute_pence)
    : 0;

  const stopCharge = settings.recalculate_on_stop_added
    ? stops * settings.extra_stop_flat_fee_pence
    : 0;

  const finalFare = quotedFare + waitingCharge + stopCharge;

  const fmt = (p: number) => `${currencySymbol}${(p / 100).toFixed(2)}`;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Calculator className="h-4 w-4 text-primary" />
          Fare Simulator
        </CardTitle>
        <CardDescription className="text-xs">Test fare calculations with current settings</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Distance ({unitShort})</Label>
            <Input type="number" min="0" step="0.5" value={distKm} onChange={(e) => setDistKm(parseFloat(e.target.value) || 0)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Duration (min)</Label>
            <Input type="number" min="0" value={durMin} onChange={(e) => setDurMin(parseInt(e.target.value) || 0)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Waiting (min)</Label>
            <Input type="number" min="0" value={waitMin} onChange={(e) => setWaitMin(parseInt(e.target.value) || 0)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Extra Stops</Label>
            <Input type="number" min="0" value={stops} onChange={(e) => setStops(parseInt(e.target.value) || 0)} />
          </div>
        </div>

        <div className="flex gap-2">
          <Button size="sm" className="flex-1" onClick={calculate}>
            <Calculator className="h-3 w-3 mr-1" /> Calculate
          </Button>
          <Button size="sm" variant="outline" onClick={reset}>
            <RotateCcw className="h-3 w-3" />
          </Button>
        </div>

        {showResult && (
          <div ref={resultRef} className="space-y-4 pt-2">
            <Separator />

            {/* Distance Band Breakdown */}
            <div className="rounded-lg border border-primary/30 bg-primary/[0.03] p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-primary">
                  Distance Band Breakdown
                </span>
                <span className="text-xs text-muted-foreground">{distKm} {unitShort} total</span>
              </div>
              {bandResult && bandResult.segments.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="h-8 text-xs">Band</TableHead>
                      <TableHead className="h-8 text-xs">Distance Used</TableHead>
                      <TableHead className="h-8 text-xs">Rate</TableHead>
                      <TableHead className="h-8 text-xs text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {bandResult.segments.map((seg, i) => (
                      <TableRow key={i}>
                        <TableCell className="py-1.5 text-xs">
                          {seg.from}–{seg.to == null ? '∞' : seg.to} {unitShort}
                        </TableCell>
                        <TableCell className="py-1.5 text-xs font-mono">
                          {seg.span.toFixed(2)} {unitShort}
                        </TableCell>
                        <TableCell className="py-1.5 text-xs font-mono">
                          {fmt(seg.rate_pence)}/{unitShort}
                        </TableCell>
                        <TableCell className="py-1.5 text-xs font-mono text-right">
                          {fmt(seg.charge_pence)}
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow>
                      <TableCell colSpan={3} className="py-1.5 text-xs font-semibold">
                        Distance Total
                      </TableCell>
                      <TableCell className="py-1.5 text-xs font-mono font-semibold text-right">
                        {fmt(distCharge)}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              ) : (
                <div className="flex items-start gap-2 text-xs text-muted-foreground p-2">
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-600" />
                  <span>
                    No distance bands configured. Using flat per-{unitShort} rate{' '}
                    <span className="font-mono">{fmt(settings.per_km_rate_pence)}/{unitShort}</span>
                    {' '}× {distKm} {unitShort} = <span className="font-mono">{fmt(distCharge)}</span>.
                  </span>
                </div>
              )}
            </div>

            {/* Fare Breakdown */}
            <div className="space-y-1.5 text-sm">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                Fare Breakdown
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Base fare</span>
                <span className="font-mono">{fmt(base)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  Distance band fare ({distKm} {unitShort})
                </span>
                <span className="font-mono">{fmt(distCharge)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Time fare ({durMin} min)</span>
                <span className="font-mono">{fmt(timeCharge)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  Waiting charge ({billableWait} billable min)
                </span>
                <span className="font-mono">{fmt(waitingCharge)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Extra stops ({stops})</span>
                <span className="font-mono">{fmt(stopCharge)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Booking fee</span>
                <span className="font-mono">{fmt(booking)}</span>
              </div>
              {quotedFare > subtotal && (
                <div className="flex justify-between text-amber-600">
                  <span>Minimum fare applied</span>
                  <span className="font-mono">{fmt(quotedFare)}</span>
                </div>
              )}
              <Separator />
              <div className="flex justify-between font-bold text-base pt-1">
                <span>Total Fare</span>
                <span className="font-mono text-primary">{fmt(finalFare)}</span>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
