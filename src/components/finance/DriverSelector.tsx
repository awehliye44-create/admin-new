import { useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Loader2, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  filterDriverOptions,
  findDriverOption,
  useAdminDriverOptions,
} from '@/hooks/useAdminDriverOptions';

export type DriverOption = {
  id: string;
  driver_code: string | null;
  first_name: string | null;
  last_name: string | null;
};

export function driverOptionLabel(d: Pick<DriverOption, 'id' | 'driver_code' | 'first_name' | 'last_name'>): string {
  const name = `${d.first_name ?? ''} ${d.last_name ?? ''}`.trim();
  if (name && d.driver_code) return `${name} (${d.driver_code})`;
  if (name) return name;
  return d.driver_code ?? d.id.slice(0, 8);
}

export function DriverSelector({
  value,
  onChange,
  regionId,
  serviceAreaId,
  fallbackLabel,
  stripeConnectOnly = false,
  className,
}: {
  value: string | null;
  onChange: (driverId: string | null, driver?: DriverOption | null) => void;
  regionId?: string | null;
  serviceAreaId?: string | null;
  /** SSOT or URL fallback when drivers row is still loading */
  fallbackLabel?: string | null;
  /** Limit to drivers with Stripe Connect (Driver Wallet Ledger). */
  stripeConnectOnly?: boolean;
  className?: string;
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const {
    data: allOptions = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useAdminDriverOptions({ regionId, serviceAreaId, stripeConnectOnly });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const selectedFromList = findDriverOption(allOptions, value);
  const displayLabel = selectedFromList
    ? driverOptionLabel(selectedFromList)
    : fallbackLabel?.trim() || null;

  const listResults = useMemo(
    () => filterDriverOptions(allOptions, search, 25),
    [allOptions, search],
  );

  const scopeHint = serviceAreaId
    ? 'in selected service area'
    : regionId
      ? 'in selected region'
      : 'platform-wide';

  return (
    <div ref={rootRef} className={cn('relative min-w-[280px]', className)}>
      {value ? (
        <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
          {isLoading && !displayLabel ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
          ) : null}
          <span className="text-sm font-medium truncate flex-1">
            {displayLabel ?? `Driver ${value.slice(0, 8)}…`}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => {
              onChange(null, null);
              setSearch('');
              setOpen(false);
            }}
            aria-label="Clear driver"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Search or pick a driver…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
            />
          </div>
          {open && (
            <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md max-h-60 overflow-y-auto">
              <p className="px-3 pt-2 pb-1 text-[11px] text-muted-foreground uppercase tracking-wide">
                {stripeConnectOnly ? 'Stripe Connect drivers' : 'Approved drivers'} {scopeHint}
              </p>
              {isLoading ? (
                <p className="p-3 text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading drivers…
                </p>
              ) : isError ? (
                <div className="p-3 text-sm space-y-2">
                  <p className="text-destructive">{(error as Error).message}</p>
                  <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
                </div>
              ) : listResults.length === 0 ? (
                <div className="p-3 text-sm text-muted-foreground space-y-1">
                  <p>
                    {search.trim()
                      ? 'No drivers match your search'
                      : `No drivers found ${scopeHint}`}
                  </p>
                  {!search.trim() && (serviceAreaId || regionId) ? (
                    <p className="text-xs">Try &quot;All Services&quot; in the service filter, or search by name/code.</p>
                  ) : null}
                </div>
              ) : (
                listResults.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted"
                    onClick={() => {
                      onChange(d.id, d);
                      setSearch('');
                      setOpen(false);
                    }}
                  >
                    {driverOptionLabel(d)}
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
