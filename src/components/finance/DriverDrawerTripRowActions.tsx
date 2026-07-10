import { Link } from 'react-router-dom';
import { ExternalLink, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { TripFinancialAuditRow } from '@/hooks/useFinanceReconciliation';
import { paymentSessionsUrl } from '../../../shared/adminPaymentSessionsSSOT';
import { payoutLedgerUrl } from '../../../shared/adminPayoutLedgerSSOT';
import { driverWalletLedgerUrl } from '@/lib/driverWalletLedgerRoutes';

/**
 * FR audit-only trip actions. Capture / refund / sync / repair live on Payment Sessions.
 */
export function DriverDrawerTripRowActions({
  row,
  driverId,
  onViewTrip,
}: {
  row: TripFinancialAuditRow;
  driverId: string;
  onViewTrip: (row: TripFinancialAuditRow) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={() => onViewTrip(row)}>View trip audit</DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to={paymentSessionsUrl({ tripId: row.trip_id })} className="flex items-center">
            Open Payment Sessions
            <ExternalLink className="h-3 w-3 ml-auto opacity-50" />
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to={driverWalletLedgerUrl(driverId, 'ledger')} className="flex items-center">
            Open Driver Wallet
            <ExternalLink className="h-3 w-3 ml-auto opacity-50" />
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to={payoutLedgerUrl({ driverId })} className="flex items-center">
            Open Payout Ledger
            <ExternalLink className="h-3 w-3 ml-auto opacity-50" />
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to={`/trip-history?tripId=${encodeURIComponent(row.trip_id)}`}>Trip history</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
