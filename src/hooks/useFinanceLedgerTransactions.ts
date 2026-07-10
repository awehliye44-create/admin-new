import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatPence } from '@/hooks/useDriverWallet';
import {
  adminCustomerPaymentMeta,
  adminDiscountMeta,
  adminFinanceLedgerDirection,
  adminFinanceLedgerMatchesFilter,
  adminFinanceLedgerTypeMeta,
  ADMIN_CUSTOMER_PAYMENT_ROW_TYPE,
  ADMIN_DEBT_RECOVERY_LEDGER_TYPES,
  ADMIN_DISCOUNT_ROW_TYPE,
  type AdminFinanceLedgerFilter,
  type AdminFinanceParty,
} from '@/lib/adminFinanceLedgerDisplay';
import { attachRunningBalancesNewestFirst } from '@/lib/driverWalletRunningBalanceSSOT';

export type FinanceLedgerTransactionRow = {
  id: string;
  created_at: string;
  trip_id: string | null;
  trip_code: string | null;
  driver_id: string | null;
  driver_name: string | null;
  customer_name: string | null;
  type: string;
  type_label: string;
  party: AdminFinanceParty;
  direction: 'credit' | 'debit';
  amount_pence: number;
  currency: string;
  payment_method: string | null;
  source: string;
  status: string | null;
  ledger_reference: string | null;
  description: string | null;
  notes: string | null;
  evidence: string | null;
  running_balance_pence?: number | null;
};

type LedgerDbRow = {
  id: string;
  type: string;
  amount_pence: number;
  currency: string | null;
  description: string | null;
  created_at: string;
  related_trip_id: string | null;
  driver_id: string;
  stripe_transfer_id: string | null;
  stripe_payout_id: string | null;
  drivers: { first_name: string | null; last_name: string | null; region_id?: string | null } | null;
  trips: {
    trip_code: string | null;
    payment_method: string | null;
    passenger_id: string | null;
    passenger_name: string | null;
    discount_pence: number | null;
    discount_source: string | null;
  } | null;
};

type PaymentDbRow = {
  id: string;
  trip_id: string | null;
  driver_id: string | null;
  status: string | null;
  captured_amount_pence: number | null;
  amount_pence: number | null;
  currency: string | null;
  stripe_fee_pence: number | null;
  payment_provider: string | null;
  provider_webhook_event_id: string | null;
  created_at: string;
  trips: {
    trip_code: string | null;
    payment_method: string | null;
    passenger_id: string | null;
    passenger_name: string | null;
  } | null;
  drivers: { first_name: string | null; last_name: string | null; region_id?: string | null } | null;
};

type DiscountTripRow = {
  id: string;
  trip_code: string | null;
  payment_method: string | null;
  completed_at: string | null;
  discount_pence: number | null;
  discount_source: string | null;
  driver_id: string | null;
  passenger_id: string | null;
  passenger_name: string | null;
  drivers: { first_name: string | null; last_name: string | null } | null;
};

const LEDGER_SELECT = `
  id, type, amount_pence, currency, description, created_at, related_trip_id,
  driver_id, stripe_transfer_id, stripe_payout_id,
  drivers(first_name, last_name, region_id),
  trips(trip_code, payment_method, passenger_id, passenger_name, discount_pence, discount_source)
`;


function formatName(first: string | null | undefined, last: string | null | undefined): string | null {
  const name = `${first ?? ''} ${last ?? ''}`.trim();
  return name || null;
}

function mapLedgerRow(row: LedgerDbRow): FinanceLedgerTransactionRow {
  const meta = adminFinanceLedgerTypeMeta(row.type);
  const trip = row.trips;
  const evidenceParts = [row.stripe_payout_id, row.stripe_transfer_id].filter(Boolean);
  return {
    id: row.id,
    created_at: row.created_at,
    trip_id: row.related_trip_id,
    trip_code: trip?.trip_code ?? null,
    driver_id: row.driver_id,
    driver_name: formatName(row.drivers?.first_name, row.drivers?.last_name),
    customer_name: trip?.passenger_name ?? null,
    type: row.type,
    type_label: meta.label,
    party: meta.party,
    direction: adminFinanceLedgerDirection(row.amount_pence),
    amount_pence: row.amount_pence,
    currency: (row.currency ?? 'GBP').toUpperCase(),
    payment_method: trip?.payment_method ?? null,
    source: row.stripe_transfer_id || row.stripe_payout_id ? 'Provider' : 'ledger',
    status: 'posted',
    ledger_reference: row.id,
    description: row.description,
    notes: row.description,
    evidence: evidenceParts.length ? evidenceParts.join(' · ') : null,
  };
}

function mapPaymentRow(row: PaymentDbRow): FinanceLedgerTransactionRow {
  const meta = adminCustomerPaymentMeta();
  const amount = row.captured_amount_pence ?? row.amount_pence ?? 0;
  const trip = row.trips;
  return {
    id: `payment-${row.id}`,
    created_at: row.created_at,
    trip_id: row.trip_id,
    trip_code: trip?.trip_code ?? null,
    driver_id: row.driver_id,
    driver_name: formatName(row.drivers?.first_name, row.drivers?.last_name),
    customer_name: trip?.passenger_name ?? null,
    type: ADMIN_CUSTOMER_PAYMENT_ROW_TYPE,
    type_label: meta.label,
    party: meta.party,
    direction: 'credit',
    amount_pence: amount,
    currency: row.currency ?? 'gbp',
    payment_method: trip?.payment_method ?? 'card',
    source: row.provider_webhook_event_id ? 'webhook' : (row.payment_provider ?? 'Provider'),
    status: row.status,
    ledger_reference: row.id,
    description: row.stripe_fee_pence
      ? `Provider fee ${formatPence(row.stripe_fee_pence, row.currency ?? 'gbp')}`
      : null,
    notes: null,
    evidence: row.provider_webhook_event_id ?? row.id,
  };
}

function mapDiscountRow(row: DiscountTripRow): FinanceLedgerTransactionRow {
  const meta = adminDiscountMeta();
  const discountPence = row.discount_pence ?? 0;
  return {
    id: `discount-${row.id}`,
    created_at: row.completed_at ?? new Date(0).toISOString(),
    trip_id: row.id,
    trip_code: row.trip_code,
    driver_id: row.driver_id,
    driver_name: formatName(row.drivers?.first_name, row.drivers?.last_name),
    customer_name: row.passenger_name ?? null,
    type: ADMIN_DISCOUNT_ROW_TYPE,
    type_label: row.discount_source === 'voucher' ? 'Voucher discount' : 'Global discount',
    party: meta.party,
    direction: 'debit',
    amount_pence: -Math.abs(discountPence),
    currency: 'gbp',
    payment_method: row.payment_method,
    source: 'system',
    status: null,
    ledger_reference: row.id,
    description: row.discount_source ?? null,
    notes: row.discount_source ?? null,
    evidence: row.id,
  };
}

function rowMatchesFilter(row: FinanceLedgerTransactionRow, filter: AdminFinanceLedgerFilter): boolean {
  if (filter === 'all') return true;
  if (row.type === ADMIN_CUSTOMER_PAYMENT_ROW_TYPE) return filter === 'customer_payments';
  if (row.type === ADMIN_DISCOUNT_ROW_TYPE) return filter === 'discounts';
  return adminFinanceLedgerMatchesFilter(row.type, filter);
}

function regionMatches(regionId: string | null | undefined, rowRegionId: string | null | undefined): boolean {
  if (!regionId) return true;
  return rowRegionId === regionId;
}

async function fetchLedgerRows(args: {
  filter: AdminFinanceLedgerFilter;
  regionId?: string | null;
  driverId?: string | null;
  limit: number;
  from?: string;
  to?: string;
}): Promise<FinanceLedgerTransactionRow[]> {
  // For a selected driver: load unfiltered chronological series so running balance
  // is SSOT over the full wallet account (not a filtered subset from £0).
  const balanceScoped = Boolean(args.driverId);

  let query = supabase
    .from('driver_wallet_ledger')
    .select(LEDGER_SELECT)
    .order('created_at', { ascending: false })
    .limit(balanceScoped ? Math.max(args.limit, 2000) : args.limit);

  if (args.driverId) query = query.eq('driver_id', args.driverId);
  if (args.to) query = query.lte('created_at', args.to);
  // When computing running balance for a driver, include history before `from`
  // so opening balance is correct; period filter applied after attach.

  if (!balanceScoped) {
    if (args.from) query = query.gte('created_at', args.from);
    if (args.filter === 'debt_recovery') {
      query = query.in('type', [...ADMIN_DEBT_RECOVERY_LEDGER_TYPES]);
    } else if (args.filter === 'driver_earnings') {
      query = query.in('type', ['TRIP_EARNING_NET', 'DRIVER_TIP_CREDIT', 'CASH_TRIP_EARNING', 'PROMOTION', 'TRIP_CREDIT']);
    } else if (args.filter === 'onecab_commission') {
      query = query.in('type', ['PLATFORM_COMMISSION', 'COMMISSION_RECOVERED']);
    } else if (args.filter === 'payouts') {
      query = query.in('type', [
        'WEEKLY_PAYOUT', 'EARLY_CASHOUT', 'MANUAL_PAYOUT', 'PAYOUT', 'PAYOUT_CREATED',
        'CASHOUT_FEE', 'PAYOUT_FAILED_RETURN', 'PAYOUT_REVERSAL',
      ]);
    } else if (args.filter === 'refunds') {
      query = query.in('type', ['REFUND_DEBIT', 'CHARGEBACK_DEBIT']);
    } else if (args.filter === 'adjustments') {
      query = query.in('type', [
        'ADJUSTMENT', 'MANUAL_ADJUSTMENT', 'MANUAL_CREDIT', 'MANUAL_DEBIT',
        'LEDGER_REVERSAL', 'CORRECTION',
      ]);
    } else if (args.filter === 'bonus') {
      query = query.in('type', ['BONUS', 'PROMOTION']);
    }
  }

  const { data, error } = await query;
  if (error) throw error;

  let mapped: FinanceLedgerTransactionRow[] = [];
  for (const row of (data ?? []) as LedgerDbRow[]) {
    if (!regionMatches(args.regionId, row.drivers?.region_id)) continue;
    mapped.push(mapLedgerRow(row));
  }

  if (balanceScoped && mapped.length > 0) {
    let opening = 0;
    if (args.from) {
      const { data: prior, error: priorErr } = await supabase
        .from('driver_wallet_ledger')
        .select('amount_pence')
        .eq('driver_id', args.driverId!)
        .lt('created_at', args.from)
        .limit(10000);
      if (priorErr) throw priorErr;
      opening = (prior ?? []).reduce((s, r) => s + Number(r.amount_pence ?? 0), 0);
    }
    mapped = attachRunningBalancesNewestFirst(mapped, opening);
    if (args.from) {
      mapped = mapped.filter((r) => r.created_at >= args.from!);
    }
  }

  return mapped
    .filter((row) => rowMatchesFilter(row, args.filter))
    .slice(0, args.limit);
}

export function useFinanceLedgerTransactions(args: {
  filter: AdminFinanceLedgerFilter;
  regionId?: string | null;
  driverId?: string | null;
  limit?: number;
  from?: string;
  to?: string;
}) {
  const limit = args.limit ?? 300;
  const ledgerLimit = args.filter === 'all' ? limit : limit;

  return useQuery({
    queryKey: ['finance-ledger-transactions', args.filter, args.regionId, args.driverId, limit, args.from, args.to],
    queryFn: async (): Promise<FinanceLedgerTransactionRow[]> => {
      const includePayments = !args.driverId && (args.filter === 'all' || args.filter === 'customer_payments');
      const includeDiscounts = !args.driverId && (args.filter === 'all' || args.filter === 'discounts');
      const includeLedger = args.filter === 'all'
        || (args.filter !== 'customer_payments' && args.filter !== 'discounts');

      const rows: FinanceLedgerTransactionRow[] = [];

      if (includeLedger) {
        rows.push(...await fetchLedgerRows({
          filter: args.filter,
          regionId: args.regionId,
          driverId: args.driverId,
          limit: ledgerLimit,
          from: args.from,
          to: args.to,
        }));
      }

      if (includePayments) {
        let paymentQuery = supabase
          .from('payments')
          .select(`
            id, trip_id, driver_id, status, captured_amount_pence, amount_pence, currency,
            stripe_fee_pence, payment_provider, provider_webhook_event_id, created_at,
            trips(trip_code, payment_method, passenger_id, passenger_name),
            drivers(first_name, last_name, region_id)
          `)
          .in('status', ['captured', 'paid', 'succeeded'])
          .order('created_at', { ascending: false })
          .limit(includePayments && !includeLedger ? limit : Math.min(limit, 150));

        if (args.driverId) paymentQuery = paymentQuery.eq('driver_id', args.driverId);
        if (args.from) paymentQuery = paymentQuery.gte('created_at', args.from);
        if (args.to) paymentQuery = paymentQuery.lte('created_at', args.to);

        const { data: paymentData, error: paymentError } = await paymentQuery;
        if (paymentError) throw paymentError;
        for (const row of (paymentData ?? []) as unknown as PaymentDbRow[]) {
          if (!regionMatches(args.regionId, row.drivers?.region_id)) continue;
          rows.push(mapPaymentRow(row));
        }
      }

      if (includeDiscounts) {
        let discountQuery: any = (supabase as any)
          .from('trips')
          .select(`
            id, trip_code, payment_method, completed_at, discount_pence, discount_source,
            driver_id, passenger_id, passenger_name, region_id,
            drivers(first_name, last_name)
          `)
          .gt('discount_pence', 0)
          .order('completed_at', { ascending: false })
          .limit(Math.min(limit, 100));

        if (args.regionId) {
          discountQuery = discountQuery.eq('region_id', args.regionId);
        }
        if (args.driverId) {
          discountQuery = discountQuery.eq('driver_id', args.driverId);
        }
        if (args.from) discountQuery = discountQuery.gte('completed_at', args.from);
        if (args.to) discountQuery = discountQuery.lte('completed_at', args.to);

        const { data: discountData, error: discountError } = await discountQuery;
        if (discountError) throw discountError;
        for (const row of (discountData ?? []) as unknown as DiscountTripRow[]) {
          rows.push(mapDiscountRow(row));
        }
      }

      rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      return rows.slice(0, limit);
    },
  });
}
