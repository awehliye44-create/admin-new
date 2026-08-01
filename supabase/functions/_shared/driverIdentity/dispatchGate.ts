/**
 * Shared identity dispatch gate for offer-producing paths.
 * Returns reject reason string when the driver must not receive NEW offers.
 * Does not cancel accepted work — callers only skip candidate selection.
 */
export async function getIdentityDispatchRejectReason(
  // deno-lint-ignore no-explicit-any
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: any; error: any }> },
  driverId: string,
): Promise<string | null> {
  const { data: gate, error } = await supabase.rpc(
    "get_driver_identity_verification_gate",
    { p_driver_id: driverId },
  );
  if (error || !gate) return null;
  if (gate.dispatch_blocked !== true && gate.blocking !== true) return null;

  const code = String(gate.code || "IDENTITY_VERIFICATION_REQUIRED");
  switch (code) {
    case "IDENTITY_VERIFICATION_PROCESSING":
      return "identity_verification_processing";
    case "IDENTITY_VERIFICATION_UNDER_REVIEW":
      return "identity_verification_under_review";
    case "IDENTITY_VERIFICATION_BLOCKED":
      return "identity_verification_blocked";
    case "IDENTITY_REFERENCE_UNAVAILABLE":
      return "identity_reference_unavailable";
    case "IDENTITY_VERIFICATION_DEFERRED_ACTIVE_WORK":
      // Still block NEW offers while deferred.
      return "identity_verification_required";
    case "IDENTITY_VERIFICATION_REQUIRED":
    default:
      return "identity_verification_required";
  }
}
