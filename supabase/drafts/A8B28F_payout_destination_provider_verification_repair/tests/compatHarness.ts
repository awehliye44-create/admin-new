/** Local harness re-exports + mixed-version interpret helper for simulation. */
export * from "../shared/payoutDestinationVerificationOutcomeSSOT.ts";

export function interpretCompat(input: {
  httpOk: boolean;
  httpStatus: number;
  payload: Record<string, unknown> | null;
}): { ok: boolean } {
  const payload = input.payload ?? {};
  const outcome = String(payload.outcome ?? "").toUpperCase();
  const link = String(payload.provider_link_status ?? "").toUpperCase();
  const autoLinked = payload.provider_auto_linked === true;
  if (
    outcome === "DESTINATION_SAVED_AND_VERIFIED" ||
    outcome === "DESTINATION_ALREADY_VERIFIED" ||
    (input.httpOk && autoLinked && link === "PROVIDER_VERIFIED")
  ) {
    return { ok: true };
  }
  if (!input.httpOk || input.httpStatus === 422 || link === "FAILED" || outcome.includes("FAILED")) {
    return { ok: false };
  }
  return { ok: false };
}
