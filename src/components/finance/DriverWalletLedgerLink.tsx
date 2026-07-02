import { Link } from 'react-router-dom';
import {
  driverWalletLedgerUrl,
  parseDriverWalletLedgerTab,
  type DriverWalletLedgerLegacyTab,
  type DriverWalletLedgerTab,
} from '@/lib/driverWalletLedgerRoutes';

export type DriverWalletLedgerTabParam = DriverWalletLedgerTab | DriverWalletLedgerLegacyTab;

export function DriverWalletLedgerLink({
  driverId,
  tab = 'overview',
  children,
  className = 'font-medium hover:underline',
}: {
  driverId: string | null | undefined;
  tab?: DriverWalletLedgerTabParam;
  children?: React.ReactNode;
  className?: string;
}) {
  if (!driverId) {
    return <span className={className}>{children ?? '—'}</span>;
  }

  const canonicalTab = parseDriverWalletLedgerTab(tab);

  return (
    <Link
      to={driverWalletLedgerUrl(driverId, canonicalTab)}
      className={className}
      title="Open Driver Wallet Ledger"
    >
      {children ?? 'Open Driver Wallet Ledger'}
    </Link>
  );
}
