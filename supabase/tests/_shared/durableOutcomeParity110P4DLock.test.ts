/**
 * #110 P4D — same-isolate tip finalize must share durable settlement SSOT with HTTP finalize.
 *
 * Run:
 *   deno test --allow-read supabase/tests/_shared/durableOutcomeParity110P4DLock.test.ts
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  durableSettlementColumns,
  needsDurableSettlementPersist,
} from "../../functions/_shared/durableSettlementOutcomeSSOT.ts";

const immediate = await Deno.readTextFile(
  new URL("../../functions/_shared/tipWindowImmediateFinalizeSSOT.ts", import.meta.url),
);
const httpFinalize = await Deno.readTextFile(
  new URL("../../functions/finalize-trip-and-capture/index.ts", import.meta.url),
);
const libReexport = await Deno.readTextFile(
  new URL(
    "../../functions/finalize-trip-and-capture/lib/durableSettlementOutcomeSSOT.ts",
    import.meta.url,
  ),
);

Deno.test("#110 P4D HTTP and same-isolate both persist durable outcomes via shared SSOT", () => {
  assertStringIncludes(immediate, "persistDurableSettlementOutcomeIfNeeded");
  assertStringIncludes(immediate, "persistDurableSettlementOutcome");
  assertStringIncludes(httpFinalize, "persistDurableSettlementOutcomeIfNeeded");
  assertStringIncludes(httpFinalize, "persistDurableSettlementOutcome");
  assertStringIncludes(libReexport, "../../_shared/durableSettlementOutcomeSSOT.ts");
  // No second local settlement map in the HTTP handler.
  assertEquals(httpFinalize.includes("function durableSettlementColumns"), false);
});

Deno.test("#110 P4D tip outcomes never invent fare payment_shortfall", () => {
  const tipDecline = durableSettlementColumns("tip_authorisation_declined", false);
  assertEquals(tipDecline.payment_status, "authorized");
  const tipShortfall = durableSettlementColumns("tip_shortfall", false);
  assertEquals(tipShortfall.payment_status !== "payment_shortfall", true);
});

Deno.test("#110 P4D unconfirmed capture must not stamp captured", () => {
  const cols = durableSettlementColumns("captured_unconfirmed", true);
  assertEquals(cols.payment_status !== "captured", true);
});

Deno.test("#110 P4D captured remains sticky against later non-capture finalize", () => {
  assertEquals(
    needsDurableSettlementPersist({
      paymentStatus: "captured",
      paymentHoldStatus: "captured",
      finalizeSuccess: false,
      finalizeStatus: "authorized",
    }),
    false,
  );
});

Deno.test("#110 P4D same-isolate covers provider_authorisation_missing + trusted tip", () => {
  assertStringIncludes(immediate, "provider_authorisation_missing");
  assertStringIncludes(immediate, "resolveTrustedCaptureTipPence");
  assertStringIncludes(immediate, "tripProviderOrderId");
  assert(
    immediate.lastIndexOf("persistDurableSettlementOutcomeIfNeeded") >
      immediate.lastIndexOf("await finalizeRevolutTripCapture"),
  );
});
