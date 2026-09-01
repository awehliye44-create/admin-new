import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { financialReconciliationIssuesTabUrl } from '@/lib/financialReconciliationRoutes';

type PaymentSessionsCompactCreditNoticeProps = {
  exceptionTripCount: number;
};

/** Compact FR link — Payment Sessions does not own wallet reconciliation. */
export function PaymentSessionsCompactCreditNotice({
  exceptionTripCount,
}: PaymentSessionsCompactCreditNoticeProps) {
  if (exceptionTripCount <= 0) return null;

  return (
    <p className="text-xs text-muted-foreground">
      <Link
        className="underline underline-offset-2 hover:text-foreground"
        to={financialReconciliationIssuesTabUrl('driver_credit')}
      >
        Driver credit issues: {exceptionTripCount} — View in Financial Reconciliation
      </Link>
    </p>
  );
}
