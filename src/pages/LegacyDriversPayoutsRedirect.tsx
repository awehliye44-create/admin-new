import { Navigate, useSearchParams } from 'react-router-dom';

/** Legacy Drivers & Payouts routes → SSOT finance pages. */
export default function LegacyDriversPayoutsRedirect() {
  const [searchParams] = useSearchParams();
  const tab = searchParams.get('tab');
  if (tab === 'ledger') {
    return <Navigate to="/driver-wallet-ledger?tab=ledger" replace />;
  }
  if (tab === 'connect-balance' || tab === 'stripe') {
    return <Navigate to="/driver-wallet-ledger?tab=stripe" replace />;
  }
  return <Navigate to="/financial-reconciliation" replace />;
}
