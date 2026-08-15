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
 *
 * Identity hierarchy (never UUID-first):
 * 1. Driver name (profiles.full_name / drivers.first_name+last_name)
 * 2. Driver code (drivers.driver_code)
 * 3. Internal UUID as secondary audit only
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
    driver.next_scheduled_payout_local ?? null,
  ].filter(Boolean).join(' · ') || '—';

  const displayName = driver.driver_name?.trim() || null;
  const displayCode = driver.driver_code?.trim() || null;

  return (
    <Card>
      <CardContent className="pt-4 pb-4 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Driver</p>
            <h2 className="text-lg font-semibold mt-0.5">
              {displayName ?? displayCode ?? 'Unknown driver'}
            </h2>
            {displayName && displayCode ? (
              <p className="text-sm text-muted-foreground mt-0.5">{displayCode}</p>
            ) : null}
            <p className="text-[11px] text-muted-foreground font-mono mt-1" title={driver.driver_id}>
              Internal ID: {driver.driver_id}
            </p>
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
            label="Payout Destination Status"
            value={driver.verification_status ?? (driver.connected_account_id ? 'legacy_connect' : 'manual_bank')}
          />
          <Field label="Bank / Revolut Account" value={bankLabel} />
          <Field label="Next Scheduled Payout" value={nextPayout} />
          <Field label="Last Payout" value={lastPayout} />
        </div>
      </CardContent>
    </Card>
  );
}
