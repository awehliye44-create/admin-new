import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useEffect, useMemo, useRef } from 'react';
import { useServiceAreas, type ServiceArea } from '@/hooks/useServiceAreas';
import { getCurrencySymbol } from '@/lib/regionSettings';
import { MapPin } from 'lucide-react';
import {
  emptyServiceAreaScopeMessage,
  filterServiceAreasByFinancialModel,
  type FinancialModel,
} from '../../../shared/financialModelScopeSSOT';

/**
 * Financial-model scope for the dropdown.
 * Finance SSOT pages MUST pass a concrete model — the two pipelines never mix.
 * `ALL_OPERATIONAL` exists only for non-finance operational pages (trip ops lists).
 */
export type ServiceAreaFilterScope = FinancialModel | 'ALL_OPERATIONAL';

export interface ServiceAreaFinanceSelection {
  /** null = "All Services" (within the page's financial model only) */
  serviceAreaId: string | null;
  /** Resolved region_id for filtering drivers */
  regionId: string | null;
  /** Currency code from the selected service area's region */
  currencyCode: string | null;
}

interface ServiceAreaFinanceFilterProps {
  value: ServiceAreaFinanceSelection;
  onChange: (selection: ServiceAreaFinanceSelection) => void;
  /** Required: which financial pipeline this page belongs to. */
  financialModel: ServiceAreaFilterScope;
  className?: string;
  /** When false, parent must set initial scope before finance SSOT queries run. */
  autoSelectFirstArea?: boolean;
}

export function ServiceAreaFinanceFilter({
  value,
  onChange,
  financialModel,
  className,
  autoSelectFirstArea = true,
}: ServiceAreaFinanceFilterProps) {
  const { data: allAreas = [], isLoading } = useServiceAreas({ activeOnly: true });
  const didAutoSelectRef = useRef(false);

  // Fail-closed: only the two concrete pipelines scope the dropdown.
  const concreteModel =
    financialModel === 'PLATFORM_COLLECTED' || financialModel === 'DRIVER_COLLECTED_COMMISSION_WALLET'
      ? financialModel
      : null;

  const serviceAreas: ServiceArea[] = useMemo(
    () => (concreteModel ? filterServiceAreasByFinancialModel(allAreas, concreteModel) : allAreas),
    [allAreas, concreteModel],
  );


  // A selection made under another scope must never leak across pipelines.
  useEffect(() => {
    if (!value.serviceAreaId) return;
    if (isLoading) return;
    if (serviceAreas.some(sa => sa.id === value.serviceAreaId)) return;
    onChange({ serviceAreaId: null, regionId: null, currencyCode: null });
  }, [isLoading, onChange, serviceAreas, value.serviceAreaId]);

  // Scope FR SSOT to a region by default — unscoped loads are slow and can fail on large fleets.
  useEffect(() => {
    if (!autoSelectFirstArea) return;
    if (didAutoSelectRef.current || isLoading || value.regionId || value.serviceAreaId) return;
    const first = serviceAreas[0];
    if (!first) return;
    didAutoSelectRef.current = true;
    const cc = first.region?.currency_code || first.currency_code || null;
    onChange({ serviceAreaId: first.id, regionId: first.region_id, currencyCode: cc });
  }, [autoSelectFirstArea, isLoading, onChange, serviceAreas, value.regionId, value.serviceAreaId]);

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

  const emptyScope = !isLoading && serviceAreas.length === 0;

  if (emptyScope && financialModel !== 'ALL_OPERATIONAL') {
    return (
      <div className={`flex items-center gap-2 text-sm text-muted-foreground ${className ?? ''}`}>
        <MapPin className="h-4 w-4 shrink-0" />
        {emptyServiceAreaScopeMessage(financialModel)}
      </div>
    );
  }

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
