import { format } from 'date-fns';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';
import { formatNullablePence } from '@/lib/formatNullablePence';

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return format(new Date(iso), 'dd MMM yyyy HH:mm');
  } catch {
    return iso;
  }
}

function statusVariant(status: string | null | undefined): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'ACTIVE') return 'default';
  if (status === 'RESTRICTED' || status === 'NOT_CONNECTED') return 'secondary';
  return 'destructive';
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-medium mt-0.5 break-all">{value}</p>
    </div>
  );
}

/**
 * Driver financial account header — identity + payout connectivity only.
 * Does not own bank transfer execution (Payout Ledger).
 */
export function DriverWalletAccountHeader({
  driver,
  currencyCode = 'GBP',
}: {
  driver: DriverWalletSsotRow;
  currencyCode?: string;
}) {
  const bankLabel = driver.bank_account_last4
    ? `•••• ${driver.bank_account_last4}`
    : driver.connected_account_id
    ? 'Linked'
    : '—';

  const lastPayout = driver.last_payout_at
    ? `${formatNullablePence(driver.last_payout_amount_pence, currencyCode)} · ${fmtDate(driver.last_payout_at)}`
    : '—';

  const nextPayout = [
    formatNullablePence(driver.scheduled_payout_display_pence, currencyCode),
    driver.next_scheduled_payout_at ? fmtDate(driver.next_scheduled_payout_at) : null,
  ].filter(Boolean).join(' · ') || '—';

  return (
    <Card>
      <CardContent className="pt-4 pb-4 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{driver.driver_name ?? driver.driver_code ?? 'Driver'}</h2>
            <p className="text-xs text-muted-foreground font-mono mt-0.5">{driver.driver_id}</p>
          </div>
          <Badge variant={statusVariant(driver.wallet_status)}>
            {driver.wallet_status ?? '—'}
          </Badge>
        </div>

        <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
          <Field label="Driver Tier" value={driver.driver_tier_name ?? '—'} />
          <Field
            label="Commission %"
            value={driver.commission_percent != null ? `${driver.commission_percent}%` : '—'}
          />
          <Field label="Service Area" value={driver.service_area_name ?? '—'} />
          <Field label="Payout Provider" value={driver.payout_provider ?? '—'} />
          <Field
            label="Connected Account Status"
            value={driver.verification_status ?? (driver.connected_account_id ? 'connected' : 'not_connected')}
          />
          <Field label="Bank / Revolut Account" value={bankLabel} />
          <Field label="Next Scheduled Payout" value={nextPayout} />
          <Field label="Last Payout" value={lastPayout} />
        </div>
      </CardContent>
    </Card>
  );
}
