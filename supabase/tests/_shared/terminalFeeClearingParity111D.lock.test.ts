/**
 * #111D LOCK — terminal-fee earnings share the same 27h clearing SSOT as
 * normal trip earnings. No separate cancellation clearing config or window.
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

const ROOT = new URL("../../", import.meta.url);

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, ROOT));
}

Deno.test("#111D SQL clearing delay is admin_settings SSOT with 27h fallback", async () => {
  // Latest eligibility migration still delegates to the shared delay helper.
  const eligibility = await read(
    "migrations/20261205120000_terminal_wallet_eligibility_and_stamp_invariant.sql",
  );
  assertStringIncludes(eligibility, "driver_wallet_payout_clearing_delay_hours");
  assertStringIncludes(eligibility, "driver_wallet_stable_clearing_origin");
  // Terminal kind branch uses the same clearing path as completed trips.
  assertStringIncludes(eligibility, "v_terminal_kind");
  assertStringIncludes(eligibility, "v_requires_clearing");
});

Deno.test("#111D TS clearing default matches SQL fallback (27h)", async () => {
  const ssot = await read("functions/_shared/driverPayoutEligibilitySSOT.ts");
  assertStringIncludes(ssot, "DEFAULT_PAYOUT_CLEARING_DELAY_HOURS = 27");
  assertStringIncludes(ssot, "isPayoutClearedForPlatformCollected");
  assertStringIncludes(ssot, "resolveStablePayoutClearingOriginMs");
});

Deno.test("#111D terminal resume does not invent a separate clearing timer", async () => {
  const resume = await read("functions/_shared/terminalFeeSettlementResumptionSSOT.ts");
  assertEquals(/clearing_delay|27\s*\*\s*3600|setTimeout/.test(resume), false);
  const entitlement = await read("functions/_shared/terminalOutcomeEntitlementSSOT.ts");
  assertEquals(/clearing_delay|CLEARING_HOURS/.test(entitlement), false);
});

Deno.test("#111D CANCELLED_WITH_FEE kind is chargeable without alternate clearing", async () => {
  const kind = await read("functions/_shared/terminalOutcomeKindSSOT.ts");
  assertStringIncludes(kind, '"CANCELLED_WITH_FEE"');
  const mig = await read(
    "migrations/20270304180000_bug111c_terminal_fee_cancelled_with_fee_kind.sql",
  );
  assertStringIncludes(mig, "CANCELLED_WITH_FEE");
  assertEquals(/clearing_delay|payout_clearing/.test(mig), false);
});
