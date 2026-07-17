// Payment Authorisation Lifecycle SSOT — hold release guard.
//
// The original AUTHORISED hold on a RIDE_BOOKING payment_sessions row MUST
// remain active until one of:
//   - capture_success          (fare captured against original or additional auth)
//   - recovery_captured        (a PAYMENT_RECOVERY session captured successfully)
//   - admin_abandon_recovery   (admin explicitly abandons recovery)
//   - provider_expired         (Revolut expiry, applied by webhook)
//
// This helper is called from any code path that would cancel/release a
// still-AUTHORISED hold and prevents accidental releases during recovery.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type HoldReleaseTrigger =
  | "capture_success"
  | "recovery_captured"
  | "admin_abandon_recovery"
  | "provider_expired";

export interface HoldGuardArgs {
  tripId: string;
  reason: HoldReleaseTrigger;
}

export interface HoldGuardResult {
  allowed: boolean;
  reason_code?: "HOLD_PROTECTED_BY_RECOVERY" | "HOLD_ALREADY_RELEASED";
  message?: string;
  parent_session_id?: string | null;
  parent_provider_state?: string | null;
  recovery_session_id?: string | null;
  recovery_status?: string | null;
}

const OPEN_RECOVERY_STATUSES = new Set([
  "PAYMENT_RECOVERY_REQUIRED",
  "RECOVERY_CHECKOUT_CREATED",
  "CUSTOMER_ACTION_REQUIRED",
]);

/** Returns { allowed: false } if the original hold must not be released. */
export async function assertHoldReleaseAllowed(
  supabase: SupabaseClient,
  args: HoldGuardArgs,
): Promise<HoldGuardResult> {
  const { data: parent, error } = await supabase
    .from("payment_sessions")
    .select("id, provider_state, status, metadata")
    .eq("trip_id", args.tripId)
    .eq("purpose", "RIDE_BOOKING")
    .maybeSingle();
  if (error || !parent) {
    // No parent session — nothing to protect.
    return { allowed: true };
  }
  const providerState = (parent.provider_state ?? "").toUpperCase();
  if (providerState !== "AUTHORISED") {
    // Hold already terminal at provider — no protection needed.
    return { allowed: true, parent_session_id: parent.id, parent_provider_state: providerState };
  }

  // Look for an open recovery session for this trip.
  const { data: recovery } = await supabase
    .from("payment_sessions")
    .select("id, status")
    .eq("trip_id", args.tripId)
    .eq("purpose", "PAYMENT_RECOVERY")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const meta = (parent.metadata ?? {}) as { additional_auth_status?: string };
  const recoveryPending =
    (recovery && OPEN_RECOVERY_STATUSES.has((recovery.status ?? "").toUpperCase()))
    || meta.additional_auth_status === "PAYMENT_RECOVERY_REQUIRED";

  if (recoveryPending && args.reason !== "admin_abandon_recovery" && args.reason !== "recovery_captured") {
    return {
      allowed: false,
      reason_code: "HOLD_PROTECTED_BY_RECOVERY",
      message:
        "Original authorisation is protected while a payment recovery is in flight. "
        + "Complete recovery, wait for provider expiry, or pass abandon_recovery=true to force-release.",
      parent_session_id: parent.id,
      parent_provider_state: providerState,
      recovery_session_id: recovery?.id ?? null,
      recovery_status: recovery?.status ?? null,
    };
  }
  return {
    allowed: true,
    parent_session_id: parent.id,
    parent_provider_state: providerState,
    recovery_session_id: recovery?.id ?? null,
    recovery_status: recovery?.status ?? null,
  };
}

/** Stamp the release trigger on the parent session so downstream triggers accept the write. */
export async function stampReleaseTrigger(
  supabase: SupabaseClient,
  parentSessionId: string,
  trigger: HoldReleaseTrigger,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const { data: sess } = await supabase
    .from("payment_sessions")
    .select("metadata")
    .eq("id", parentSessionId)
    .maybeSingle();
  const meta = (sess?.metadata && typeof sess.metadata === "object") ? sess.metadata : {};
  await supabase
    .from("payment_sessions")
    .update({
      metadata: {
        ...meta,
        release_trigger: trigger,
        release_trigger_at: new Date().toISOString(),
        ...extra,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", parentSessionId);
}
