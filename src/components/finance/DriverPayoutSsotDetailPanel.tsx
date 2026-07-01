import type { ComponentType } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatPence } from '@/hooks/useDriverWallet';
import type { ConnectBalanceAccount } from '@/hooks/useConnectPayoutStatus';
import {
  formatAdminDriverPayoutSsotSummary,
} from '@/lib/driverPayoutSsot';
import { format } from 'date-fns';
import { AlertTriangle, Banknote, Calculator, Landmark, Wallet } from 'lucide-react';

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return format(new Date(iso), 'dd MMM yyyy HH:mm');
  } catch {
    return iso;
  }
}

function SsotRow({
  label,
  value,
  mono,
  highlight,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 border-b border-border/50 last:border-0">
      <span className="text-muted-foreground text-sm shrink-0">{label}</span>
      <span className={`text-sm text-right ${mono ? 'font-mono' : ''} ${highlight ? 'font-semibold' : ''}`}>
        {value}
      </span>
    </div>
  );
}

function SectionCard({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Icon className="h-4 w-4" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-0">{children}</CardContent>
    </Card>
  );
}

export function DriverPayoutSsotDetailPanel({
  row,
  currencyCode,
  platformStripe,
}: {
  row: ConnectBalanceAccount;
  currencyCode: string;
  platformStripe?: { available_pence: number; pending_pence: number };
}) {
  const ccy = row.currency ?? currencyCode;
  const wallet = row.onecab_wallet;
  const connect = row.stripe_connect;
  const platform = row.platform_reconciliation;
  const cashout = row.cashout_decision;

  const summary = formatAdminDriverPayoutSsotSummary({
    walletOwedPence: cashout?.wallet_owed_pence ?? row.wallet_owed_pence ?? row.wallet_balance_pence,
    connectAvailablePence: cashout?.connect_available_pence ?? row.connect_instant_available_pence ?? row.connect_available_pence,
    cashoutNowPence: cashout?.cashout_now_pence ?? row.cashout_now_pence,
    currencyCode: ccy,
  });

  return (
    <div className="space-y-4">
      <Alert>
        <Calculator className="h-4 w-4" />
        <AlertDescription className="text-sm">{summary}</AlertDescription>
      </Alert>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="1. ONECAB Wallet Ledger (current liability)" icon={Wallet}>
          <p className="text-xs text-muted-foreground mb-2">
            Ledger SSOT only — what ONECAB owes the driver. Not Stripe cash and not lifetime earnings.
          </p>
          <SsotRow
            label="Driver earned / owed"
            value={formatPence(wallet?.driver_earned_owed_pence ?? row.wallet_owed_pence ?? 0, ccy)}
            highlight
          />
          <SsotRow
            label="Ledger balance (signed)"
            value={formatPence(wallet?.ledger_balance_pence ?? row.wallet_balance_pence, ccy)}
            mono
          />
          <SsotRow
            label="Trip earnings"
            value={formatPence(wallet?.trip_earnings_pence ?? 0, ccy)}
            mono
          />
          <SsotRow
            label="Debt recovery"
            value={formatPence(wallet?.debt_recovery_pence ?? 0, ccy)}
            mono
          />
          <SsotRow
            label="Adjustments"
            value={formatPence(wallet?.adjustments_pence ?? 0, ccy)}
            mono
          />
          {wallet?.paid_out_pence != null && wallet.paid_out_pence > 0 && (
            <SsotRow
              label="Paid out (ledger)"
              value={formatPence(wallet.paid_out_pence, ccy)}
              mono
            />
          )}
        </SectionCard>

        <SectionCard title="2. Stripe Connect Balance (physical money)" icon={Banknote}>
          <p className="text-xs text-muted-foreground mb-2">
            Cash on the driver&apos;s Express account only. Ledger entitlement ≠ Stripe cash.
            Standard available supports scheduled payout; instant available supports Early Cash Out when enabled.
          </p>
          <SsotRow
            label="Connected account ID"
            value={connect?.stripe_account_id ?? row.stripe_account_id}
            mono
          />
          <SsotRow
            label="Account type"
            value={(connect?.account_type ?? row.connect_account_type ?? '—').toString()}
          />
          <SsotRow
            label="Payouts enabled"
            value={(connect?.payouts_enabled ?? row.payouts_enabled) ? 'Yes' : 'No'}
          />
          <SsotRow
            label="Stripe Connect standard (scheduled payout)"
            value={formatPence(connect?.available_to_payout_pence ?? row.connect_available_pence, ccy)}
            mono
            highlight
          />
          <SsotRow
            label="Stripe Connect instant (Early Cash Out cap)"
            value={formatPence(connect?.instant_available_pence ?? row.connect_instant_available_pence ?? 0, ccy)}
            mono
          />
          <SsotRow
            label="Available soon / pending"
            value={formatPence(connect?.pending_pence ?? row.connect_pending_pence, ccy)}
            mono
          />
          <SsotRow
            label="In transit to bank"
            value={formatPence(connect?.in_transit_pence ?? row.connect_in_transit_pence ?? 0, ccy)}
            mono
          />
          <SsotRow
            label="Last payout"
            value={
              connect?.last_payout_amount_pence != null
                ? `${formatPence(connect.last_payout_amount_pence, ccy)} (${connect.last_payout_status ?? '—'}) · ${formatDate(connect.last_payout_date)}`
                : row.last_payout_amount_pence != null
                  ? `${formatPence(row.last_payout_amount_pence, ccy)} (${row.last_payout_status ?? '—'}) · ${formatDate(row.last_payout_date)}`
                  : '—'
            }
          />
          <SsotRow
            label="Next payout date"
            value={formatDate(connect?.next_payout_date ?? row.next_payout_date)}
          />
        </SectionCard>

        <SectionCard title="3. Financial Reconciliation (liability vs Connect)" icon={Landmark}>
          <p className="text-xs text-muted-foreground mb-2">
            Compares ONECAB ledger liability to Stripe Connect cash evidence without mixing buckets.
          </p>
          <SsotRow
            label="Platform Stripe available"
            value={formatPence(platform?.platform_available_pence ?? platformStripe?.available_pence ?? 0, ccy)}
            mono
          />
          <SsotRow
            label="Platform pending"
            value={formatPence(platform?.platform_pending_pence ?? platformStripe?.pending_pence ?? 0, ccy)}
            mono
          />
          <SsotRow
            label="Allocated to this driver"
            value={formatPence(platform?.platform_allocated_to_driver_pence ?? 0, ccy)}
            mono
          />
          <SsotRow
            label="Application fees (ONECAB net)"
            value={formatPence(platform?.application_fees_pence ?? 0, ccy)}
            mono
          />
          <SsotRow
            label="Transfers sent to Connect"
            value={`${platform?.transfers_to_connect_count ?? 0} transfer(s) · ${formatPence(platform?.transfers_to_connect_pence ?? 0, ccy)}`}
            mono
          />
          <SsotRow
            label="Provider settlement evidence"
            value={platform?.provider_settlement_evidence ?? row.reconciliation_status ?? '—'}
          />
          <SsotRow
            label="Reconciliation status"
            value={platform?.reconciliation_status ?? row.reconciliation_status ?? '—'}
          />
        </SectionCard>

        <SectionCard title="4. Payout / cash-out decision" icon={Calculator}>
          <p className="text-xs text-muted-foreground mb-2 font-mono">
            scheduled = min(ledger owed, finance-cleared, Connect standard) · instant = min(ledger, finance-cleared, Connect instant) when platform + service area allow
          </p>
          <SsotRow
            label="Driver wallet balance (ledger)"
            value={formatPence(cashout?.wallet_owed_pence ?? row.wallet_owed_pence ?? row.wallet_balance_pence ?? 0, ccy)}
            mono
            highlight
          />
          <SsotRow
            label="Finance cleared"
            value={formatPence(cashout?.finance_cleared_pence ?? row.finance_cleared_pence ?? row.onecab_available_now_pence, ccy)}
            mono
          />
          <SsotRow
            label="Stripe Connect standard"
            value={formatPence(cashout?.connect_available_pence ?? row.connect_available_pence, ccy)}
            mono
          />
          <SsotRow
            label="Stripe Connect instant"
            value={formatPence(row.connect_instant_available_pence ?? 0, ccy)}
            mono
          />
          <SsotRow
            label="Scheduled payout available (Stripe standard cap)"
            value={formatPence(cashout?.connect_available_pence ?? row.connect_available_pence, ccy)}
            mono
          />
          <SsotRow
            label="Instant cash out now"
            value={formatPence(cashout?.cashout_now_pence ?? row.cashout_now_pence, ccy)}
            mono
            highlight
          />
          <SsotRow
            label="Awaiting settlement"
            value={formatPence(cashout?.awaiting_settlement_pence ?? row.awaiting_settlement_pence, ccy)}
            mono
          />
          <div className="pt-2">
            {(cashout?.block_reasons ?? row.cashout_block_reasons ?? []).length > 0 ? (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Block reason(s)</p>
                <ul className="space-y-1">
                  {(cashout?.block_reasons ?? row.cashout_block_reasons ?? []).map((r) => (
                    <li key={r} className="text-sm text-destructive flex items-start gap-1">
                      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      {r}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <Badge variant="default">Cash-out enabled</Badge>
            )}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
