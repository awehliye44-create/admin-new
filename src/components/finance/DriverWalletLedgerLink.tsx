import { Link } from 'react-router-dom';
import {
  driverWalletLedgerUrl,
  type DriverWalletLedgerTab,
} from '@/lib/driverWalletLedgerRoutes';

export function DriverWalletLedgerLink({
  driverId,
  tab = 'overview',
  children,
  className = 'font-medium hover:underline',
}: {
  driverId: string | null | undefined;
  tab?: DriverWalletLedgerTab;
  children?: React.ReactNode;
  className?: string;
}) {
  if (!driverId) {
    return <span className={className}>{children ?? '—'}</span>;
  }

  return (
    <Link
      to={driverWalletLedgerUrl(driverId, tab)}
      className={className}
      title="Open Driver Wallet Ledger"
    >
      {children ?? 'Open Driver Wallet Ledger'}
    </Link>
  );
}
