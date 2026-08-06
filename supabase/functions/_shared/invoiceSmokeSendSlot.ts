/**
 * DB-backed smoke send slot acquisition for edge functions.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type SmokeSlotRpcResult = {
  ok: boolean;
  code: string;
  successful_send_count?: number;
  max_successful_sends?: number;
  attempted_send_count?: number;
  reserved_send_count?: number;
};

export async function acquireInvoiceSmokeSendSlot(
  supabase: SupabaseClient,
  smokeRunId: string,
): Promise<SmokeSlotRpcResult> {
  const { data, error } = await supabase.rpc("acquire_invoice_smoke_send_slot", {
    p_smoke_run_id: smokeRunId,
  });
  if (error) return { ok: false, code: "SMOKE_SLOT_RPC_FAILED" };
  const row = (data ?? {}) as SmokeSlotRpcResult;
  return {
    ok: Boolean(row.ok),
    code: String(row.code ?? (row.ok ? "SLOT_ACQUIRED" : "SMOKE_SEND_LIMIT_REACHED")),
    successful_send_count: row.successful_send_count,
    max_successful_sends: row.max_successful_sends,
    attempted_send_count: row.attempted_send_count,
    reserved_send_count: row.reserved_send_count,
  };
}

export async function confirmInvoiceSmokeSendSlot(
  supabase: SupabaseClient,
  smokeRunId: string,
): Promise<void> {
  await supabase.rpc("confirm_invoice_smoke_send_slot", { p_smoke_run_id: smokeRunId });
}

export async function releaseInvoiceSmokeSendSlot(
  supabase: SupabaseClient,
  smokeRunId: string,
): Promise<void> {
  await supabase.rpc("release_invoice_smoke_send_slot", { p_smoke_run_id: smokeRunId });
}

export async function loadSmokeRunAllowlists(
  supabase: SupabaseClient,
  smokeRunId: string,
): Promise<{
  allowlistedDriverIds: string[];
  allowlistedCustomerIds: string[];
  status: string;
} | null> {
  const { data } = await supabase
    .from("invoice_smoke_runs")
    .select("allowlisted_driver_ids, allowlisted_customer_ids, status")
    .eq("smoke_run_id", smokeRunId)
    .maybeSingle();
  if (!data) return null;
  return {
    allowlistedDriverIds: (data.allowlisted_driver_ids as string[] | null) ?? [],
    allowlistedCustomerIds: (data.allowlisted_customer_ids as string[] | null) ?? [],
    status: String(data.status ?? ""),
  };
}
