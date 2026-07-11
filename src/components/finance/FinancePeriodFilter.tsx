import { useEffect, useState } from 'react';
import { CalendarIcon } from 'lucide-react';
import { format } from 'date-fns';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import type { FinancePeriod } from '@/lib/financePeriodFilter';

const DEFAULT_PERIODS: Array<{ value: FinancePeriod; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'week', label: 'This week' },
  { value: 'last_week', label: 'Last week' },
  { value: 'month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'This year' },
  { value: 'last_year', label: 'Last year' },
  { value: 'lifetime', label: 'Lifetime' },
  { value: 'custom', label: 'Custom' },
];

/** Driver Wallet Statements — Daily / Weekly / Monthly / Quarterly / Annual / Custom. */
const STATEMENT_PERIODS: Array<{ value: FinancePeriod; label: string }> = [
  { value: 'today', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
  { value: 'quarter', label: 'Quarterly' },
  { value: 'year', label: 'Annual' },
  { value: 'custom', label: 'Custom' },
];

export function FinancePeriodFilter({
  period,
  onPeriodChange,
  customFrom,
  customTo,
  onCustomFromChange,
  onCustomToChange,
  variant = 'default',
}: {
  period: FinancePeriod;
  onPeriodChange: (period: FinancePeriod) => void;
  customFrom?: Date;
  customTo?: Date;
  onCustomFromChange: (date: Date | undefined) => void;
  onCustomToChange: (date: Date | undefined) => void;
  variant?: 'default' | 'statement';
}) {
  const periods = variant === 'statement' ? STATEMENT_PERIODS : DEFAULT_PERIODS;
  const [draftFrom, setDraftFrom] = useState<Date | undefined>(customFrom);
  const [draftTo, setDraftTo] = useState<Date | undefined>(customTo);

  useEffect(() => {
    setDraftFrom(customFrom);
    setDraftTo(customTo);
  }, [customFrom, customTo]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Tabs
        value={period}
        onValueChange={(v) => {
          onPeriodChange(v as FinancePeriod);
          if (v !== 'custom') {
            onCustomFromChange(undefined);
            onCustomToChange(undefined);
            setDraftFrom(undefined);
            setDraftTo(undefined);
          }
        }}
      >
        <TabsList className="flex flex-wrap h-auto gap-1">
          {periods.map((p) => (
            <TabsTrigger key={p.value} value={p.value}>{p.label}</TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {period === 'custom' && (
        <div className="flex flex-wrap items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  'w-[130px] justify-start text-left font-normal',
                  !draftFrom && 'text-muted-foreground',
                )}
              >
                <CalendarIcon className="mr-2 h-4 w-4" />
                {draftFrom ? format(draftFrom, 'MMM d, yyyy') : 'From'}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0 z-[9999]" align="start">
              <Calendar
                mode="single"
                selected={draftFrom}
                onSelect={setDraftFrom}
                disabled={(date) => date > new Date()}
                initialFocus
                captionLayout="dropdown-buttons"
                fromYear={2020}
                toYear={new Date().getFullYear()}
                className={cn('p-3 pointer-events-auto')}
              />
            </PopoverContent>
          </Popover>
          <span className="text-muted-foreground text-sm">to</span>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  'w-[130px] justify-start text-left font-normal',
                  !draftTo && 'text-muted-foreground',
                )}
              >
                <CalendarIcon className="mr-2 h-4 w-4" />
                {draftTo ? format(draftTo, 'MMM d, yyyy') : 'To'}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0 z-[9999]" align="start">
              <Calendar
                mode="single"
                selected={draftTo}
                onSelect={setDraftTo}
                disabled={(date) => date > new Date() || (draftFrom ? date < draftFrom : false)}
                initialFocus
                captionLayout="dropdown-buttons"
                fromYear={2020}
                toYear={new Date().getFullYear()}
                className={cn('p-3 pointer-events-auto')}
              />
            </PopoverContent>
          </Popover>
          <Button
            type="button"
            size="sm"
            disabled={!draftFrom || !draftTo}
            onClick={() => {
              onCustomFromChange(draftFrom);
              onCustomToChange(draftTo);
            }}
          >
            Apply
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setDraftFrom(undefined);
              setDraftTo(undefined);
              onCustomFromChange(undefined);
              onCustomToChange(undefined);
            }}
          >
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}
