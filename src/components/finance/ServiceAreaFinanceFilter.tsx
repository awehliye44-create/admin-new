import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useEffect, useRef } from 'react';
import { useServiceAreas, type ServiceArea } from '@/hooks/useServiceAreas';
import { getCurrencySymbol } from '@/lib/regionSettings';
import { MapPin } from 'lucide-react';

export interface ServiceAreaFinanceSelection {
  /** null = "All Services" */
  serviceAreaId: string | null;
  /** Resolved region_id for filtering drivers */
  regionId: string | null;
  /** Currency code from the selected service area's region */
  currencyCode: string | null;
}

interface ServiceAreaFinanceFilterProps {
  value: ServiceAreaFinanceSelection;
  onChange: (selection: ServiceAreaFinanceSelection) => void;
  className?: string;
}

export function ServiceAreaFinanceFilter({ value, onChange, className }: ServiceAreaFinanceFilterProps) {
  const { data: serviceAreas = [], isLoading } = useServiceAreas({ activeOnly: true });
  const didAutoSelectRef = useRef(false);

  // Scope FR SSOT to a region by default — unscoped loads are slow and can fail on large fleets.
  useEffect(() => {
    if (didAutoSelectRef.current || isLoading || value.regionId || value.serviceAreaId) return;
    const first = serviceAreas[0];
    if (!first) return;
    didAutoSelectRef.current = true;
    const cc = first.region?.currency_code || first.currency_code || null;
    onChange({ serviceAreaId: first.id, regionId: first.region_id, currencyCode: cc });
  }, [isLoading, onChange, serviceAreas, value.regionId, value.serviceAreaId]);

  const handleChange = (val: string) => {
    if (val === '__all__') {
      onChange({ serviceAreaId: null, regionId: null, currencyCode: null });
      return;
    }
    const sa = serviceAreas.find(s => s.id === val);
    if (sa) {
      const cc = sa.region?.currency_code || sa.currency_code || null;
      onChange({ serviceAreaId: sa.id, regionId: sa.region_id, currencyCode: cc });
    }
  };

  return (
    <Select value={value.serviceAreaId || '__all__'} onValueChange={handleChange}>
      <SelectTrigger className={className || 'w-[220px]'}>
        <div className="flex items-center gap-2">
          <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
          <SelectValue placeholder={isLoading ? 'Loading...' : 'All Services'} />
        </div>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all__">All Services</SelectItem>
        {serviceAreas.map(sa => {
          const cc = sa.region?.currency_code || sa.currency_code;
          return (
            <SelectItem key={sa.id} value={sa.id}>
              {sa.name} {cc ? `(${getCurrencySymbol(cc)})` : ''}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

/** Default empty selection */
export const DEFAULT_SERVICE_AREA_SELECTION: ServiceAreaFinanceSelection = {
  serviceAreaId: null,
  regionId: null,
  currencyCode: null,
};
