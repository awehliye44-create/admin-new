import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type DriverOption = {
  id: string;
  driver_code: string | null;
  first_name: string | null;
  last_name: string | null;
};

function driverLabel(d: DriverOption): string {
  const name = `${d.first_name ?? ''} ${d.last_name ?? ''}`.trim();
  if (name && d.driver_code) return `${name} (${d.driver_code})`;
  if (name) return name;
  return d.driver_code ?? d.id.slice(0, 8);
}

export function DriverSelector({
  value,
  onChange,
  regionId,
  className,
}: {
  value: string | null;
  onChange: (driverId: string | null, driver?: DriverOption | null) => void;
  regionId?: string | null;
  className?: string;
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);

  const { data: selectedDriver } = useQuery({
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

  const { data: searchResults = [], isFetching } = useQuery({
    queryKey: ['driver-selector-search', search, regionId],
    enabled: search.trim().length >= 2 && open,
    queryFn: async (): Promise<DriverOption[]> => {
      const q = search.trim();
      let query = supabase
        .from('drivers')
        .select('id, driver_code, first_name, last_name')
        .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,driver_code.ilike.%${q}%`)
        .limit(12);
      if (regionId) query = query.eq('region_id', regionId);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as DriverOption[];
    },
  });

  const displayLabel = selectedDriver ? driverLabel(selectedDriver) : null;

  return (
    <div className={cn('relative min-w-[280px]', className)}>
      {value && displayLabel ? (
        <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
          <span className="text-sm font-medium truncate flex-1">{displayLabel}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => {
              onChange(null, null);
              setSearch('');
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
              placeholder="Search driver name or code…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
            />
          </div>
          {open && search.trim().length >= 2 && (
            <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md max-h-60 overflow-y-auto">
              {isFetching ? (
                <p className="p-3 text-sm text-muted-foreground">Searching…</p>
              ) : searchResults.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">No drivers found</p>
              ) : (
                searchResults.map((d) => (
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
                    {driverLabel(d)}
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
