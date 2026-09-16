// Money totals SSOT for Payment Sessions (SSOT) admin page.
//
// Root-cause fix: Captured / Released / Refunded / Provider fee totals used to be
// summed from the attention-queue page slice (capped feed), so the cards showed
// partial sums presented as full totals. This module aggregates directly over the
// payment_sessions table for the whole filtered scope, in DB-side pages.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  confirmedCapturedRevenuePence,
  rowBelongsInCapturedTab,
  rowBelongsInRefundedTab,
  rowBelongsInReleasedTab,
  sumReleasedBufferTotalPence,
} from "../../../shared/paymentSessionsDisplaySSOT.ts";

const PAGE_SIZE = 1000;
const MAX_ROWS = 20000;

export type PaymentSessionsMoneyAggregates = {
  captured_count: number;
  captured_total_pence: number | null;
  released_count: number;
  released_buffer_total_pence: number | null;
  refunded_count: number;
  refunded_total_pence: number | null;
  provider_fees_total_pence: number | null;
  scanned_rows: number;
  truncated: boolean;
};

export type PaymentSessionsMoneyAggregateFilters = {
  allowed_service_area_ids?: readonly string[] | null;
  service_area_id?: string | null;
  date_from?: string | null;
  date_to?: string | null;
  provider?: string | null;
  customer_id?: string | null;
  trip_id?: string | null;
  payment_session_id?: string | null;
  provider_order_id?: string | null;
};

type MoneyRow = {
  id: string;
  status: string | null;
  provider_state: string | null;
  authorised_amount_pence: number | null;
  captured_amount_pence: number | null;
  released_amount_pence: number | null;
  refunded_amount_pence: number | null;
  provider_processing_fee_pence: number | null;
  fee_status: string | null;
  captured_at: string | null;
  released_at: string | null;
  refunded_at: string | null;
  service_area_id: string | null;
};

/** Provider fees only count when the provider reported the actual fee. */
export function actualProviderFeePence(row: {
  provider_processing_fee_pence?: number | null;
  fee_status?: string | null;
}): number | null {
  const status = String(row.fee_status ?? "").toUpperCase();
  if (status !== "ACTUAL") return null;
  const raw = row.provider_processing_fee_pence;
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

export function aggregatePaymentSessionsMoney(
  rows: readonly MoneyRow[],
): PaymentSessionsMoneyAggregates {
  const capturedRows = rows.filter((r) => rowBelongsInCapturedTab(r));
  const releasedRows = rows.filter((r) => rowBelongsInReleasedTab(r));
  const refundedRows = rows.filter((r) => rowBelongsInRefundedTab(r));

  let captured: number | null = null;
  for (const r of capturedRows) {
    const amt = confirmedCapturedRevenuePence(r);
    if (amt == null) continue;
    captured = (captured ?? 0) + amt;
  }

  let refunded: number | null = null;
  for (const r of refundedRows) {
    const raw = r.refunded_amount_pence;
    if (raw == null) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) continue;
    refunded = (refunded ?? 0) + Math.round(n);
  }

  let fees: number | null = null;
  for (const r of rows) {
    const fee = actualProviderFeePence(r);
    if (fee == null) continue;
    fees = (fees ?? 0) + fee;
  }

  return {
    captured_count: capturedRows.length,
    captured_total_pence: captured,
    released_count: releasedRows.length,
    released_buffer_total_pence: sumReleasedBufferTotalPence(rows as MoneyRow[]),
    refunded_count: refundedRows.length,
    refunded_total_pence: refunded,
    provider_fees_total_pence: fees,
    scanned_rows: rows.length,
    truncated: false,
  };
}

export async function fetchPaymentSessionsMoneyAggregates(
  supabase: SupabaseClient,
  filters: PaymentSessionsMoneyAggregateFilters = {},
): Promise<PaymentSessionsMoneyAggregates> {
  const allowed = filters.allowed_service_area_ids ?? null;
  const collected: MoneyRow[] = [];
  let truncated = false;

  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    let query = supabase
      .from("payment_sessions")
      .select(
        "id, status, provider_state, authorised_amount_pence, captured_amount_pence, released_amount_pence, refunded_amount_pence, provider_processing_fee_pence, fee_status, captured_at, released_at, refunded_at, service_area_id",
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    if (filters.payment_session_id) query = query.eq("id", filters.payment_session_id);
    if (filters.provider_order_id) query = query.eq("provider_order_id", filters.provider_order_id);
    if (filters.trip_id) query = query.eq("trip_id", filters.trip_id);
    if (filters.customer_id) query = query.eq("customer_id", filters.customer_id);
    if (filters.provider) query = query.eq("payment_provider", filters.provider);
    if (filters.service_area_id) query = query.eq("service_area_id", filters.service_area_id);
    if (filters.date_from) query = query.gte("created_at", filters.date_from);
    if (filters.date_to) {
      const toBound = filters.date_to.length <= 10
        ? `${filters.date_to}T23:59:59.999Z`
        : filters.date_to;
      query = query.lte("created_at", toBound);
    }
    if (allowed && allowed.length > 0) {
      query = query.in("service_area_id", [...allowed]);
    } else if (allowed && allowed.length === 0) {
      query = query.eq("service_area_id", "00000000-0000-0000-0000-000000000000");
    }

    const { data, error } = await query;
    if (error) throw error;
    const page = (data ?? []) as MoneyRow[];
    for (const row of page) {
      // Financial-model isolation: never mix non-allowlisted / null SA rows.
      if (allowed && !(row.service_area_id && allowed.includes(String(row.service_area_id)))) continue;
      collected.push(row);
    }
    if (page.length < PAGE_SIZE) break;
    if (offset + PAGE_SIZE >= MAX_ROWS) truncated = true;
  }

  const aggregates = aggregatePaymentSessionsMoney(collected);
  return { ...aggregates, truncated };
}
