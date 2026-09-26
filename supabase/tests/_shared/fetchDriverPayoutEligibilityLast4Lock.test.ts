/**
 * Lock: active destination last4 for Driver Withdraw quote authorization.
 * MK0007 had destination_last4='6010' with account_last4 NULL — reading only
 * account_last4 made GET /driver-withdraw omit masked_account, so the Driver
 * app fail-closed Withdraw (isExecutorQuoteAuthorized requires 4 digits).
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveActiveDestinationLast4 } from "../../functions/_shared/fetchDriverPayoutEligibility.ts";

Deno.test("resolveActiveDestinationLast4: prefers destination_last4 (MK0007 shape)", () => {
  assertEquals(
    resolveActiveDestinationLast4({
      destination_last4: "6010",
      account_last4: null,
    }),
    "6010",
  );
});

Deno.test("resolveActiveDestinationLast4: falls back to account_last4", () => {
  assertEquals(
    resolveActiveDestinationLast4({
      destination_last4: null,
      account_last4: "2951",
    }),
    "2951",
  );
});

Deno.test("resolveActiveDestinationLast4: strips non-digits and takes last 4", () => {
  assertEquals(
    resolveActiveDestinationLast4({
      destination_last4: "••••6010",
      account_last4: null,
    }),
    "6010",
  );
});

Deno.test("resolveActiveDestinationLast4: null when neither usable", () => {
  assertEquals(resolveActiveDestinationLast4(null), null);
  assertEquals(
    resolveActiveDestinationLast4({ destination_last4: "12", account_last4: "ab" }),
    null,
  );
});

Deno.test("fetchDriverPayoutEligibility select includes destination_last4", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/fetchDriverPayoutEligibility.ts", import.meta.url),
  );
  assertEquals(src.includes("destination_last4"), true);
  assertEquals(src.includes("resolveActiveDestinationLast4(dest)"), true);
  assertEquals(
    /active_destination_last4:\s*dest\?\.account_last4\s*\?/.test(src),
    false,
  );
});
