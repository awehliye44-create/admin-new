import { Badge } from '@/components/ui/badge';
import type { AdminPaymentSessionsSummary } from '../../../shared/adminPaymentSessionsSSOT';
import {
  buildPaymentSessionsOperationalChips,
  type PaymentSessionsNavTab,
  type PaymentSessionsOpChip,
} from '../../../shared/paymentSessionsNavigationSSOT';

type PaymentSessionsOperationalChipsProps = {
  summary: AdminPaymentSessionsSummary | null | undefined;
  onSelect: (args: { tab: PaymentSessionsNavTab; opFilter: PaymentSessionsOpChip }) => void;
};

/** Operational chips — hide zero counts; no PARTIAL / RED / sandbox noise. */
export function PaymentSessionsOperationalChips({
  summary,
  onSelect,
}: PaymentSessionsOperationalChipsProps) {
  const chips = buildPaymentSessionsOperationalChips(summary);
  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {chips.map((chip) => (
        <button
          key={chip.id}
          type="button"
          onClick={() => onSelect({
            tab: chip.navTab ?? 'recovery',
            opFilter: chip.id,
          })}
        >
          <Badge
            variant={chip.id === 'release_failed' ? 'destructive' : 'secondary'}
            className="cursor-pointer hover:opacity-90"
          >
            {chip.label} {chip.count}
          </Badge>
        </button>
      ))}
    </div>
  );
}
