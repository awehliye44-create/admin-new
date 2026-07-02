import { supabase } from '@/integrations/supabase/client';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';

export interface PayoutItem {
  id: string;
  driverId: string;
  driverName: string | null;
  amount: number;
  status: string;
  errorMessage: string | null;
  stripeTransferId: string | null;
  stripePayoutId: string | null;
  ledgerEntryId: string | null;
  walletRecalculatedAt: string | null;
  ledgerSyncError: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface PayoutBatch {
  id: string;
  kind: string;
  runDate: string;
  status: string;
  totalDrivers: number | null;
  totalAmount: number | null;
  successfulPayouts: number | null;
  failedPayouts: number | null;
  createdAt: string;
  completedAt: string | null;
  notes: string | null;
  items: PayoutItem[];
}

export interface EarlyCashoutRow {
  id: string;
  driverId: string;
  driverName: string | null;
  requestedAmount: number;
  driverReceives: number;
  feeAmount: number;
  status: string;
  payoutMethod: 'instant' | 'standard' | null;
  stripePayoutId: string | null;
  stripeTransferId: string | null;
  failureReason: string | null;
  createdAt: string;
  paidAt: string | null;
  currency: string;
}

function buildPayoutBatchesPath(filter: ServiceAreaFinanceSelection): string {
  const params = new URLSearchParams();
  if (filter.regionId) params.set('region_id', filter.regionId);
  else if (filter.serviceAreaId) params.set('service_area_id', filter.serviceAreaId);
  const qs = params.toString();
  return qs ? `admin-payout-batches?${qs}` : 'admin-payout-batches';
}

export async function fetchPayoutBatchesDirect(): Promise<PayoutBatch[]> {
  const { data: batchRows, error: batchError } = await supabase
    .from('payout_batches')
    .select('id,kind,run_date,status,total_drivers,total_amount_pence,successful_payouts,failed_payouts,notes,created_at,completed_at')
    .order('created_at', { ascending: false });

  if (batchError) throw batchError;

  const batchIds = (batchRows || []).map((b) => b.id);
  const { data: itemRows, error: itemError } = batchIds.length > 0
    ? await supabase
        .from('payout_items')
        .select('id,batch_id,driver_id,amount_pence,status,stripe_transfer_id,stripe_payout_id,ledger_entry_id,wallet_recalculated_at,ledger_sync_error,error_message,created_at,completed_at,drivers:driver_id(first_name,last_name)')
        .in('batch_id', batchIds)
    : { data: [], error: null };

  if (itemError) throw itemError;

  const itemsByBatch: Record<string, PayoutItem[]> = {};
  itemRows?.forEach((item: {
    id: string;
    batch_id: string;
    driver_id: string;
    amount_pence: number;
    status: string;
    stripe_transfer_id: string | null;
    stripe_payout_id: string | null;
    ledger_entry_id: string | null;
    wallet_recalculated_at: string | null;
    ledger_sync_error: string | null;
    error_message: string | null;
    created_at: string;
    completed_at: string | null;
    drivers: { first_name: string; last_name: string } | null;
  }) => {
    if (!itemsByBatch[item.batch_id]) itemsByBatch[item.batch_id] = [];
    itemsByBatch[item.batch_id].push({
      id: item.id,
      driverId: item.driver_id,
      driverName: item.drivers ? `${item.drivers.first_name} ${item.drivers.last_name}` : null,
      amount: item.amount_pence,
      status: item.status,
      stripeTransferId: item.stripe_transfer_id,
      stripePayoutId: item.stripe_payout_id,
      ledgerEntryId: item.ledger_entry_id,
      walletRecalculatedAt: item.wallet_recalculated_at,
      ledgerSyncError: item.ledger_sync_error,
      errorMessage: item.error_message,
      createdAt: item.created_at,
      completedAt: item.completed_at,
    });
  });

  return (batchRows || []).map((batch) => ({
    id: batch.id,
    kind: batch.kind,
    runDate: batch.run_date,
    status: batch.status,
    totalDrivers: batch.total_drivers,
    totalAmount: batch.total_amount_pence,
    successfulPayouts: batch.successful_payouts,
    failedPayouts: batch.failed_payouts,
    notes: batch.notes,
    createdAt: batch.created_at,
    completedAt: batch.completed_at,
    items: itemsByBatch[batch.id] || [],
  }));
}

async function fetchPayoutBatchesFromEdge(filter: ServiceAreaFinanceSelection): Promise<PayoutBatch[]> {
  const headers: Record<string, string> = {};
  if (filter.regionId) headers['x-region-id'] = filter.regionId;
  else if (filter.serviceAreaId) headers['x-service-area-id'] = filter.serviceAreaId;

  const path = buildPayoutBatchesPath(filter);
  const { data, error: fnError } = await supabase.functions.invoke(path, { method: 'GET', headers });
  if (fnError) throw fnError;
  return (data as { batches?: PayoutBatch[] })?.batches ?? [];
}

export async function fetchPayoutBatchesWithFallback(filter: ServiceAreaFinanceSelection): Promise<PayoutBatch[]> {
  try {
    return await fetchPayoutBatchesDirect();
  } catch (directError) {
    try {
      return await fetchPayoutBatchesFromEdge(filter);
    } catch {
      throw directError;
    }
  }
}

export async function fetchEarlyCashoutsDirect(): Promise<EarlyCashoutRow[]> {
  const { data, error } = await supabase
    .from('driver_early_cashouts')
    .select(`
      id,
      driver_id,
      requested_cashout_pence,
      driver_receives_pence,
      early_cashout_fee_pence,
      status,
      stripe_payout_id,
      stripe_transfer_id,
      payout_method,
      failure_reason,
      created_at,
      paid_at,
      currency,
      drivers:driver_id(first_name, last_name)
    `)
    .order('created_at', { ascending: false });

  if (error) throw error;

  return (data || []).map((row: {
    id: string;
    driver_id: string;
    requested_cashout_pence: number;
    driver_receives_pence: number;
    early_cashout_fee_pence: number;
    status: string;
    stripe_payout_id: string | null;
    stripe_transfer_id: string | null;
    payout_method: 'instant' | 'standard' | null;
    failure_reason: string | null;
    created_at: string;
    paid_at: string | null;
    currency: string;
    drivers: { first_name: string; last_name: string } | null;
  }) => ({
    id: row.id,
    driverId: row.driver_id,
    driverName: row.drivers ? `${row.drivers.first_name} ${row.drivers.last_name}` : null,
    requestedAmount: row.requested_cashout_pence,
    driverReceives: row.driver_receives_pence,
    feeAmount: row.early_cashout_fee_pence,
    status: row.status,
    payoutMethod: row.payout_method ?? null,
    stripePayoutId: row.stripe_payout_id,
    stripeTransferId: row.stripe_transfer_id,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    currency: row.currency,
  }));
}
