import { CalendarIcon } from 'lucide-react';
import { format } from 'date-fns';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import type { FinancePeriod } from '@/lib/financePeriodFilter';

export function FinancePeriodFilter({
  period,
  onPeriodChange,
  customFrom,
  customTo,
  onCustomFromChange,
  onCustomToChange,
}: {
  period: FinancePeriod;
  onPeriodChange: (period: FinancePeriod) => void;
  customFrom?: Date;
  customTo?: Date;
  onCustomFromChange: (date: Date | undefined) => void;
  onCustomToChange: (date: Date | undefined) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Tabs
        value={period}
        onValueChange={(v) => {
          onPeriodChange(v as FinancePeriod);
          if (v !== 'custom') {
            onCustomFromChange(undefined);
            onCustomToChange(undefined);
          }
        }}
      >
        <TabsList>
          <TabsTrigger value="today">Today</TabsTrigger>
          <TabsTrigger value="week">This week</TabsTrigger>
          <TabsTrigger value="custom">Custom</TabsTrigger>
        </TabsList>
      </Tabs>

      {period === 'custom' && (
        <div className="flex items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  'w-[130px] justify-start text-left font-normal',
                  !customFrom && 'text-muted-foreground',
                )}
              >
                <CalendarIcon className="mr-2 h-4 w-4" />
                {customFrom ? format(customFrom, 'MMM d, yyyy') : 'From'}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0 z-[9999]" align="start">
              <Calendar
                mode="single"
                selected={customFrom}
                onSelect={onCustomFromChange}
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
                  !customTo && 'text-muted-foreground',
                )}
              >
                <CalendarIcon className="mr-2 h-4 w-4" />
                {customTo ? format(customTo, 'MMM d, yyyy') : 'To'}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0 z-[9999]" align="start">
              <Calendar
                mode="single"
                selected={customTo}
                onSelect={onCustomToChange}
                disabled={(date) => date > new Date() || (customFrom ? date < customFrom : false)}
                initialFocus
                captionLayout="dropdown-buttons"
                fromYear={2020}
                toYear={new Date().getFullYear()}
                className={cn('p-3 pointer-events-auto')}
              />
            </PopoverContent>
          </Popover>
        </div>
      )}
    </div>
  );
}
