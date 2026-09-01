import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { AdminPaymentSessionsSummary } from '../../../shared/adminPaymentSessionsSSOT';
import {
  PAYMENT_SESSIONS_HISTORY_CHIPS,
  PAYMENT_SESSIONS_HISTORY_CHIP_LABELS,
  PAYMENT_SESSIONS_ISSUE_CHIPS,
  PAYMENT_SESSIONS_ISSUE_CHIP_LABELS,
  PAYMENT_SESSIONS_STATUS_CHIPS,
  PAYMENT_SESSIONS_STATUS_CHIP_LABELS,
  countPaymentSessionsIssueChip,
  countPaymentSessionsStatusChip,
  shouldShowPaymentSessionsIssueChip,
  type PaymentSessionsHistoryChip,
  type PaymentSessionsIssueChip,
  type PaymentSessionsStatusChip,
} from '../../../shared/paymentSessionsNavigationSSOT';

function ChipButton({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count?: number | null;
  onClick: () => void;
}) {
  const text = count != null && count > 0 && label !== 'All' ? `${label} ${count}` : label;
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? 'default' : 'outline'}
      className="h-8"
      onClick={onClick}
    >
      {text}
    </Button>
  );
}

export function PaymentSessionsStatusChipBar({
  active,
  summary,
  onChange,
}: {
  active: PaymentSessionsStatusChip;
  summary: AdminPaymentSessionsSummary | null | undefined;
  onChange: (chip: PaymentSessionsStatusChip) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {PAYMENT_SESSIONS_STATUS_CHIPS.map((chip) => (
        <ChipButton
          key={chip}
          active={active === chip}
          label={PAYMENT_SESSIONS_STATUS_CHIP_LABELS[chip]}
          count={countPaymentSessionsStatusChip(chip, summary)}
          onClick={() => onChange(chip)}
        />
      ))}
    </div>
  );
}

export function PaymentSessionsIssueChipBar({
  active,
  summary,
  onChange,
}: {
  active: PaymentSessionsIssueChip;
  summary: AdminPaymentSessionsSummary | null | undefined;
  onChange: (chip: PaymentSessionsIssueChip) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {PAYMENT_SESSIONS_ISSUE_CHIPS.filter((chip) => {
        const count = countPaymentSessionsIssueChip(chip, summary);
        return shouldShowPaymentSessionsIssueChip(chip, count);
      }).map((chip) => (
        <ChipButton
          key={chip}
          active={active === chip}
          label={PAYMENT_SESSIONS_ISSUE_CHIP_LABELS[chip]}
          count={countPaymentSessionsIssueChip(chip, summary)}
          onClick={() => onChange(chip)}
        />
      ))}
    </div>
  );
}

export function PaymentSessionsHistoryChipBar({
  active,
  onChange,
}: {
  active: PaymentSessionsHistoryChip;
  onChange: (chip: PaymentSessionsHistoryChip) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {PAYMENT_SESSIONS_HISTORY_CHIPS.map((chip) => (
        <ChipButton
          key={chip}
          active={active === chip}
          label={PAYMENT_SESSIONS_HISTORY_CHIP_LABELS[chip]}
          onClick={() => onChange(chip)}
        />
      ))}
    </div>
  );
}
