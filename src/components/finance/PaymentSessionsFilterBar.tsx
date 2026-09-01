import { useState } from 'react';
import { ChevronDown, Filter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  ServiceAreaFinanceFilter,
  type ServiceAreaFinanceSelection,
} from '@/components/finance/ServiceAreaFinanceFilter';
import type { PaymentSessionPurpose } from '../../../shared/paymentSessionPhase1SSOT';

const PURPOSES: PaymentSessionPurpose[] = [
  'RIDE_BOOKING',
  'SAVE_CARD',
  'PAYMENT_RECOVERY',
  'LEGACY_EVIDENCE',
];

type TriState = 'all' | 'true' | 'false';

export type PaymentSessionsFilterState = {
  serviceFilter: ServiceAreaFinanceSelection;
  dateFrom: string;
  dateTo: string;
  search: string;
  paymentMethod: string;
  providerState: string;
  provider: string;
  purpose: string;
  sessionStatus: string;
  customerId: string;
  tripIdFilter: string;
  hasTrip: TriState;
  activeHold: boolean;
  releaseFailed: boolean;
  recoveryPending: boolean;
  providerFeesPending: boolean;
  captureFailed: boolean;
};

type PaymentSessionsFilterBarProps = {
  financialModel?: 'PLATFORM_COLLECTED';
  filters: PaymentSessionsFilterState;
  onChange: (patch: Partial<PaymentSessionsFilterState>) => void;
  onClear: () => void;
  hasActiveFilters: boolean;
};

export function PaymentSessionsFilterBar({
  financialModel = 'PLATFORM_COLLECTED',
  filters,
  onChange,
  onClear,
  hasActiveFilters,
}: PaymentSessionsFilterBarProps) {
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">From</Label>
          <Input
            type="date"
            value={filters.dateFrom}
            onChange={(e) => onChange({ dateFrom: e.target.value })}
            className="w-[150px]"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">To</Label>
          <Input
            type="date"
            value={filters.dateTo}
            onChange={(e) => onChange({ dateTo: e.target.value })}
            className="w-[150px]"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Service area</Label>
          <ServiceAreaFinanceFilter
            financialModel={financialModel}
            value={filters.serviceFilter}
            onChange={(serviceFilter) => onChange({ serviceFilter })}
            autoSelectFirstArea={false}
          />
        </div>
        <div className="space-y-1 min-w-[200px] flex-1">
          <Label className="text-xs text-muted-foreground">Search trip / customer</Label>
          <Input
            value={filters.search}
            onChange={(e) => onChange({ search: e.target.value })}
            placeholder="Trip code, customer, session or order id"
            className="font-mono text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Payment method</Label>
          <Input
            value={filters.paymentMethod}
            onChange={(e) => onChange({ paymentMethod: e.target.value })}
            placeholder="e.g. card"
            className="w-[140px]"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Provider state</Label>
          <Input
            value={filters.providerState}
            onChange={(e) => onChange({ providerState: e.target.value })}
            placeholder="state"
            className="w-[140px]"
          />
        </div>
        <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1">
              <Filter className="h-3.5 w-3.5" />
              More filters
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${moreOpen ? 'rotate-180' : ''}`} />
            </Button>
          </CollapsibleTrigger>
        </Collapsible>
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={onClear}>
            Clear filters
          </Button>
        )}
      </div>

      <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
        <CollapsibleContent className="pt-2">
          <div className="flex flex-wrap items-end gap-3 border-t pt-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Customer ID</Label>
              <Input
                value={filters.customerId}
                onChange={(e) => onChange({ customerId: e.target.value })}
                placeholder="customer uuid"
                className="w-[220px] font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Trip ID</Label>
              <Input
                value={filters.tripIdFilter}
                onChange={(e) => onChange({ tripIdFilter: e.target.value })}
                placeholder="trip uuid"
                className="w-[220px] font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Has trip</Label>
              <Select
                value={filters.hasTrip}
                onValueChange={(v) => onChange({ hasTrip: v as TriState })}
              >
                <SelectTrigger className="w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="true">true</SelectItem>
                  <SelectItem value="false">false</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Purpose</Label>
              <Select value={filters.purpose} onValueChange={(v) => onChange({ purpose: v })}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {PURPOSES.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Provider</Label>
              <Select value={filters.provider} onValueChange={(v) => onChange({ provider: v })}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="revolut">revolut</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Session status</Label>
              <Input
                value={filters.sessionStatus}
                onChange={(e) => onChange({ sessionStatus: e.target.value })}
                placeholder="status"
                className="w-[140px]"
              />
            </div>
            <div className="flex flex-wrap items-center gap-4 pt-5">
              {([
                ['activeHold', 'Active hold'],
                ['releaseFailed', 'Release failed'],
                ['recoveryPending', 'Recovery pending'],
                ['providerFeesPending', 'Provider fees pending'],
                ['captureFailed', 'Capture failed'],
              ] as const).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-xs cursor-pointer">
                  <Checkbox
                    checked={filters[key]}
                    onCheckedChange={(v) => onChange({ [key]: v === true })}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

export function triStateToBool(value: TriState): boolean | null {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

export function paymentSessionsSearchMatchesRow(
  search: string,
  row: {
    payment_session_id?: string | null;
    provider_order_id?: string | null;
    trip_id?: string | null;
    trip_code?: string | null;
    customer_id?: string | null;
    customer_name?: string | null;
    customer_email?: string | null;
  },
): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    row.payment_session_id,
    row.provider_order_id,
    row.trip_id,
    row.trip_code,
    row.customer_id,
    row.customer_name,
    row.customer_email,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}
