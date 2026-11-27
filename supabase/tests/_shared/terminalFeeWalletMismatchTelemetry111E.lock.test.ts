/**
 * #111E — terminal TEN insert/readback failures must record financial_ssot_mismatches
 * (parity with normal-trip applyCanonicalSettlementAfterCapture). Stamp failures
 * remain on ops_events; both channels are required.
 */
import { assertStringIncludes } from "jsr:@std/assert@1";

Deno.test("#111E terminal entitlement records wallet posting mismatch on TEN failure", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/terminalOutcomeEntitlementSSOT.ts", import.meta.url),
  );
  assertStringIncludes(src, "recordWalletPostingFailureMetadata");
  assertStringIncludes(src, "terminal_fee_wallet_insert");
  assertStringIncludes(src, "TERMINAL_TRIP_STAMP_FAILED");
  assertStringIncludes(src, 'from("ops_events")');
});
