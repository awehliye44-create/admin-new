import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Loader2, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

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

function applyDriverScope<T extends { eq: (col: string, val: string) => T; is: (col: string, val: null) => T }>(
  query: T,
  regionId?: string | null,
  serviceAreaId?: string | null,
): T {
  let scoped = query.is('deleted_at', null);
  if (serviceAreaId) return scoped.eq('service_area_id', serviceAreaId);
  if (regionId) return scoped.eq('region_id', regionId);
  return scoped;
}

export function DriverSelector({
  value,
  onChange,
  regionId,
  serviceAreaId,
  fallbackLabel,
  className,
}: {
  value: string | null;
  onChange: (driverId: string | null, driver?: DriverOption | null) => void;
  regionId?: string | null;
  serviceAreaId?: string | null;
  /** SSOT or URL fallback when drivers row is still loading */
  fallbackLabel?: string | null;
  className?: string;
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  const { data: selectedDriver, isLoading: selectedLoading } = useQuery({
    queryKey: ['driver-selector-selected', value],
    enabled: Boolean(value),
    queryFn: async (): Promise<DriverOption | null> => {
      if (!value) return null;
      const { data, error } = await supabase
        .from('drivers')
        .select('id, driver_code, first_name, last_name')
        .eq('id', value)
        .maybeSingle();
      if (error) throw error;
      return data as DriverOption | null;
    },
  });

  const searchActive = search.trim().length >= 1;

  const { data: searchResults = [], isFetching: searchFetching } = useQuery({
    queryKey: ['driver-selector-search', search, regionId, serviceAreaId],
    enabled: searchActive && open,
    queryFn: async (): Promise<DriverOption[]> => {
      const q = search.trim();
      let query = supabase
        .from('drivers')
        .select('id, driver_code, first_name, last_name')
        .eq('approval_status', 'approved')
        .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,driver_code.ilike.%${q}%`)
        .order('first_name', { ascending: true })
        .limit(20);
      query = applyDriverScope(query, regionId, serviceAreaId);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as DriverOption[];
    },
  });

  const { data: browseResults = [], isFetching: browseFetching } = useQuery({
    queryKey: ['driver-selector-browse', regionId, serviceAreaId],
    enabled: open && !searchActive,
    queryFn: async (): Promise<DriverOption[]> => {
      let query = supabase
        .from('drivers')
        .select('id, driver_code, first_name, last_name')
        .eq('approval_status', 'approved')
        .order('first_name', { ascending: true })
        .limit(25);
      query = applyDriverScope(query, regionId, serviceAreaId);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as DriverOption[];
    },
    staleTime: 60_000,
  });

  const displayLabel = selectedDriver
    ? driverOptionLabel(selectedDriver)
    : fallbackLabel?.trim() || null;

  const listResults = searchActive ? searchResults : browseResults;
  const listFetching = searchActive ? searchFetching : browseFetching;

  return (
    <div ref={rootRef} className={cn('relative min-w-[280px]', className)}>
      {value ? (
        <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
          {selectedLoading && !displayLabel ? (
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
              {!searchActive ? (
                <p className="px-3 pt-2 pb-1 text-[11px] text-muted-foreground uppercase tracking-wide">
                  Approved drivers{serviceAreaId || regionId ? ' in scope' : ''}
                </p>
              ) : null}
              {listFetching ? (
                <p className="p-3 text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading drivers…
                </p>
              ) : listResults.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">
                  {searchActive
                    ? 'No drivers found — try another name or code'
                    : 'No approved drivers in this service area'}
                </p>
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
