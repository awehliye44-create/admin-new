import { Navigate, useSearchParams } from 'react-router-dom';

/** Legacy Drivers & Payouts routes → unified Payouts & Ledger Audit. */
export default function LegacyDriversPayoutsRedirect() {
  const [searchParams] = useSearchParams();
  const tab = searchParams.get('tab');
  if (tab === 'ledger') {
    return <Navigate to="/driver-wallet-ledger" replace />;
  }
  return <Navigate to="/payout-batches" replace />;
}
