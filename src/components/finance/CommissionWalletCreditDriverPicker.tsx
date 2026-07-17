import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Loader2, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  commissionWalletCreditDriverLabel,
  useCommissionWalletCreditDrivers,
  type CommissionWalletCreditDriver,
} from '@/hooks/useCommissionWalletCreditDrivers';

function formatMinor(n: number, currency: string): string {
  return `${currency} ${(n / 100).toFixed(2)}`;
}

export function CommissionWalletCreditDriverPicker({
  serviceAreaId,
  serviceAreaName,
  currency,
  balancesByDriverId,
  value,
  onChange,
  disabled,
}: {
  serviceAreaId: string | null;
  serviceAreaName?: string | null;
  currency: string;
  balancesByDriverId?: Record<string, { usable_minor: number; currency: string }>;
  value: string | null;
  onChange: (driverId: string | null, driver?: CommissionWalletCreditDriver | null) => void;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const { drivers, allDrivers, isLoading, isError, error, refetch, isFetching } =
    useCommissionWalletCreditDrivers({
      serviceAreaId,
      includeInactive,
      search,
      balancesByDriverId,
      currencyFallback: currency,
    });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  // Clear selection if driver leaves eligible list after SA/filter change.
  useEffect(() => {
    if (!value || !serviceAreaId) return;
    if (isLoading || isFetching) return;
    const stillEligible = allDrivers.some((d) => d.id === value);
    if (!stillEligible) onChange(null, null);
    // intentionally omit onChange from deps to avoid parent re-render loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, serviceAreaId, allDrivers, isLoading, isFetching]);

  const selected = useMemo(
    () => allDrivers.find((d) => d.id === value) ?? null,
    [allDrivers, value],
  );

  if (!serviceAreaId) {
    return (
      <div className="space-y-1">
        <Label>Driver</Label>
        <Input disabled placeholder="Select a Service Area first" />
      </div>
    );
  }

  return (
    <div ref={rootRef} className="space-y-2 relative sm:col-span-2 lg:col-span-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Label>Driver</Label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={includeInactive}
            onCheckedChange={setIncludeInactive}
            disabled={disabled}
          />
          Include inactive drivers
        </label>
      </div>

      {selected ? (
        <div className="rounded-md border bg-muted/20 p-3 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 space-y-1">
              <p className="font-medium text-sm">{commissionWalletCreditDriverLabel(selected)}</p>
              <p className="text-xs text-muted-foreground font-mono">
                Driver ID: {selected.driver_code || selected.id}
              </p>
              <p className="text-xs text-muted-foreground">Phone: {selected.phone || '—'}</p>
              <p className="text-xs text-muted-foreground">
                Vehicle: {selected.license_plate || '—'}
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Badge variant="secondary">{selected.driver_status || 'unknown'}</Badge>
                <Badge variant="outline">{selected.approval_status || '—'}</Badge>
              </div>
              <p className="text-sm pt-1">
                Current balance:{' '}
                <span className="font-semibold">
                  {formatMinor(selected.usable_balance_minor, selected.currency || currency)}
                </span>
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              disabled={disabled}
              onClick={() => {
                onChange(null, null);
                setSearch('');
              }}
              aria-label="Clear driver"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-9"
              disabled={disabled}
              placeholder={`Search drivers assigned to ${serviceAreaName || 'this Service Area'}…`}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
            />
          </div>
          {!isLoading && !isError && allDrivers.length === 0 && (
            <div className="rounded-md border border-dashed p-3 text-sm space-y-3">
              <p className="text-muted-foreground">
                No eligible drivers are assigned to this Service Area.
              </p>
              <Button asChild variant="outline" size="sm">
                <Link to="/drivers">Manage Driver Service Area Assignments</Link>
              </Button>
            </div>
          )}
          {open && allDrivers.length > 0 && (
            <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md max-h-72 overflow-y-auto">
              {isLoading ? (
                <p className="p-3 text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading drivers…
                </p>
              ) : isError ? (
                <div className="p-3 text-sm space-y-2">
                  <p className="text-destructive">{(error as Error).message}</p>
                  <Button variant="outline" size="sm" onClick={() => void refetch()}>Retry</Button>
                </div>
              ) : drivers.length === 0 ? (
                <div className="p-3 text-sm space-y-3">
                  <p className="text-muted-foreground">
                    No drivers match your search in this Service Area.
                  </p>
                </div>
              ) : (
                drivers.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className={cn(
                      'w-full text-left px-3 py-2.5 text-sm hover:bg-muted border-b last:border-b-0',
                    )}
                    onClick={() => {
                      onChange(d.id, d);
                      setSearch('');
                      setOpen(false);
                    }}
                  >
                    <div className="font-medium">{commissionWalletCreditDriverLabel(d)}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                      {d.phone || '—'} · {d.license_plate || 'No plate'} ·{' '}
                      {formatMinor(d.usable_balance_minor, d.currency || currency)} ·{' '}
                      {d.driver_status}
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
