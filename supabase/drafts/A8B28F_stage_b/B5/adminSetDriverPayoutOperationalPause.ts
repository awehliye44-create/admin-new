/**
 * A8B28F Stage B5 DRAFT — Admin pause/resume via B1 RPC.
 *
 * Replace direct drivers.update({ payouts_enabled }) in:
 * - src/pages/PayoutLedger.tsx → updatePayoutPause
 * - src/components/finance/PayoutLedgerSettingsPanel.tsx → driverOverrideMutation
 *
 * Rules:
 * - Pause/resume only (never destination verify)
 * - Reason required
 * - Call admin_set_driver_payout_operational_pause
 * - Do not deploy Admin UI before B1 migration exists
 * - Old Admin bundle remains safe (direct writes) until this ships
 */

import { supabase } from "@/integrations/supabase/client";

export type AdminPayoutPauseResult =
  | { ok: true; unchanged: boolean; paused: boolean }
  | { ok: false; reason: string; code?: string };

export async function adminSetDriverPayoutOperationalPause(input: {
  driverId: string;
  paused: boolean;
  reason: string;
}): Promise<AdminPayoutPauseResult> {
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 3 || reason.length > 500) {
    return { ok: false, reason: "A reason between 3 and 500 characters is required.", code: "REASON_REQUIRED" };
  }

  const { data, error } = await supabase.rpc("admin_set_driver_payout_operational_pause", {
    p_driver_id: input.driverId,
    p_paused: input.paused,
    p_reason: reason,
  });

  if (error) {
    const msg = error.message ?? "Pause update failed";
    // Fail closed when B1 not applied yet — do not fall back to direct payouts_enabled write.
    if (/function .* does not exist|Could not find the function/i.test(msg)) {
      return {
        ok: false,
        reason: "Operational pause control is not available yet. Try again after the finance update.",
        code: "RPC_NOT_DEPLOYED",
      };
    }
    if (/not authorized|42501|permission/i.test(msg)) {
      return { ok: false, reason: "You do not have permission to pause payouts.", code: "42501" };
    }
    return { ok: false, reason: "Could not update payout pause. Please try again.", code: error.code };
  }

  const row = (data ?? {}) as { ok?: boolean; unchanged?: boolean; payout_operational_paused?: boolean };
  return {
    ok: true,
    unchanged: row.unchanged === true,
    paused: row.payout_operational_paused === true || input.paused,
  };
}

/** Drop-in body for PayoutLedger.updatePayoutPause */
export async function updatePayoutPauseViaRpc(row: {
  driver_id: string;
  paused: boolean;
  name?: string | null;
  code?: string | null;
}): Promise<void> {
  const action = row.paused ? "resume" : "pause";
  const reason = window.prompt(
    `Reason to ${action} payouts for ${row.name ?? row.code ?? "driver"} (required):`,
  );
  if (reason == null) return;
  const result = await adminSetDriverPayoutOperationalPause({
    driverId: row.driver_id,
    paused: !row.paused,
    reason,
  });
  if (!result.ok) throw new Error(result.reason);
}
