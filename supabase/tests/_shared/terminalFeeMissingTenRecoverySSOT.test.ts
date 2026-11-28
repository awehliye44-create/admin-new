/**
 * #111A — terminal-fee missing TEN recovery must cover no_show / fee cancel
 * and resume must credit before stamp (never stamp-before-post).
 *
 * Run: deno test --allow-read supabase/tests/_shared/terminalFeeMissingTenRecoverySSOT.test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { TERMINAL_FEE_MISSING_TEN_RECOVERY_SOURCE } from "../../functions/sweep-revolut-stale-holds/lib/terminalFeeMissingTenRecoverySSOT.ts";

Deno.test("#111A recovery source constant", () => {
  assertEquals(
    TERMINAL_FEE_MISSING_TEN_RECOVERY_SOURCE,
    "sweep_terminal_fee_missing_ten_111a",
  );
});

Deno.test("#111A recovery SSOT includes no_show status cohort", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../functions/_shared/terminalFeeMissingTenRecoverySSOT.ts",
      import.meta.url,
    ),
  );
  assertStringIncludes(src, '"no_show"');
  assertStringIncludes(src, "sweepRecoverTerminalFeeMissingTen");
  assertStringIncludes(src, "maybeResumeTerminalFeeSettlementAfterProviderFee");
  assertStringIncludes(src, "findTerminalFeeMissingTenCandidates");
  assertStringIncludes(src, "payment_refunded_or_released");
});

Deno.test("#111A resume credits before stamp on first post", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../functions/_shared/terminalFeeSettlementResumptionSSOT.ts",
      import.meta.url,
    ),
  );
  assertStringIncludes(src, "#111A");
  const alreadyPostedIdx = src.indexOf("if (alreadyPosted)");
  const postCallIdx = src.indexOf(
    "const posted = await postTerminalEntitlementFromSettlement({",
  );
  const stampAfterCreditIdx = src.indexOf(
    "const stamp = await stampTerminalOutcomeTripRow({",
    postCallIdx,
  );
  assert(alreadyPostedIdx > 0, "alreadyPosted branch required");
  assert(postCallIdx > alreadyPostedIdx, "post must follow alreadyPosted branch");
  assert(
    stampAfterCreditIdx > postCallIdx,
    "first-credit path must stamp after postTerminalEntitlementFromSettlement",
  );
  // Stamp-only repair lives inside alreadyPosted (before the credit post call).
  const stampInAlreadyPosted = src.indexOf(
    "stampTerminalOutcomeTripRow({",
    alreadyPostedIdx,
  );
  assert(
    stampInAlreadyPosted > alreadyPostedIdx && stampInAlreadyPosted < postCallIdx,
    "alreadyPosted path must stamp-repair before any new credit post",
  );
});

Deno.test("#111A sweep wires terminal fee missing TEN recovery", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/sweep-revolut-stale-holds/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "sweepRecoverTerminalFeeMissingTen");
  assertStringIncludes(src, "terminal_fee_missing_ten_111a");
  assertStringIncludes(src, "terminal_fee_missing_ten_recovery");
});

Deno.test("#111A capture evidence prefers highest captured session", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../../functions/_shared/terminalOutcomeEntitlementSSOT.ts",
      import.meta.url,
    ),
  );
  assertStringIncludes(src, 'order("captured_amount_pence"');
  assert(
    !src.includes('.order("captured_at", { ascending: false })'),
    "must not select capture evidence by captured_at alone",
  );
});
