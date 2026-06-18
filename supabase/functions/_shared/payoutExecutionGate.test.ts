import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isPayoutVerificationMode,
} from "./payoutExecutionGate.ts";

Deno.test("isPayoutVerificationMode accepts dry_run", () => {
  assertEquals(isPayoutVerificationMode({ dry_run: true }), true);
});

Deno.test("isPayoutVerificationMode accepts verification_mode", () => {
  assertEquals(isPayoutVerificationMode({ verification_mode: true }), true);
});

Deno.test("isPayoutVerificationMode false by default", () => {
  assertEquals(isPayoutVerificationMode({}), false);
  assertEquals(isPayoutVerificationMode({ confirm_payout: true }), false);
});
