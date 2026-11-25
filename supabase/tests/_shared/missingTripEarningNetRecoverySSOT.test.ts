/**
 * Lock: automatic recovery for provider-confirmed captures missing TRIP_EARNING_NET.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  expectedTenCreditFromSavedStamps,
  INCOMPLETE_SETTLEMENT_RECOVERY_ACTIVATED_AT_MS,
  isPlatformCollectedModel,
  MISSING_TEN_RECOVERY_REASON,
} from "../../functions/_shared/missingTripEarningNetRecoverySSOT.ts";
import { paymentSessionAllowsWalletPosting } from "../../functions/_shared/postCaptureSettlementBoundary.ts";
import { mayRetryWalletPosting } from "../../functions/_shared/postCaptureSettlementBoundary.ts";

Deno.test("expected TEN credit uses saved stamps only", () => {
  assertEquals(
    expectedTenCreditFromSavedStamps({
      driver_net_pence: 2646,
      airport_charge_pence: 0,
    }),
    2646,
  );
  assertEquals(
    expectedTenCreditFromSavedStamps({
      driver_net_pence: 2646,
      airport_charge_pence: 200,
    }),
    2846,
  );
});

Deno.test("PLATFORM_COLLECTED only for missing-TEN recovery", () => {
  assertEquals(isPlatformCollectedModel("PLATFORM_COLLECTED"), true);
  assertEquals(
    isPlatformCollectedModel("DRIVER_COLLECTED_COMMISSION_WALLET"),
    false,
  );
});

Deno.test("incomplete settlement activation override allows recovery posting", () => {
  assertEquals(
    mayRetryWalletPosting({
      capture_completed_at_iso: "2026-11-22T21:19:34.764Z",
      activated_at_ms: null,
    }),
    false,
  );
  assertEquals(
    mayRetryWalletPosting({
      capture_completed_at_iso: "2026-11-22T21:19:34.764Z",
      activated_at_ms: INCOMPLETE_SETTLEMENT_RECOVERY_ACTIVATED_AT_MS,
    }),
    true,
  );
});

Deno.test("MK-261122 residual release marker does not block wallet gate", () => {
  assertEquals(
    paymentSessionAllowsWalletPosting({
      status: "captured",
      provider_state: "COMPLETED",
      captured_amount_pence: 2940,
      provider_state_verified_at: "2026-11-22T21:19:35.946Z",
      hold_release_state: "released",
      released_amount_pence: null,
      hold_terminal_reason: "provider_captured",
    }),
    true,
  );
  assertEquals(MISSING_TEN_RECOVERY_REASON, "PROVIDER_CONFIRMED_CAPTURE_MISSING_TRIP_EARNING_NET");
});

Deno.test("settlement-before-residual order locked in revolutCompletionCapture", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutCompletionCapture.ts", import.meta.url),
  );
  const marker = "Settlement before residual evidence (MK-261122-001 residual race)";
  assertEquals(src.includes(marker), true);
  // Every residualLocked / residualRec persist must follow a settlement call in the same block.
  const residualLockedIdx = src.indexOf(
    "const residualLocked = await persistPostCaptureResidualReleaseEvidence({",
  );
  const beforeLocked = src.lastIndexOf(
    "const posting = await ensurePostCaptureSettlement(decision.captureAmountPence);",
    residualLockedIdx,
  );
  assertEquals(beforeLocked > 0 && beforeLocked < residualLockedIdx, true);
  const residualRecIdx = src.indexOf(
    "const residualRec = await persistPostCaptureResidualReleaseEvidence({",
  );
  const beforeRec = src.lastIndexOf(
    "const posting = await ensurePostCaptureSettlement(decision.captureAmountPence);",
    residualRecIdx,
  );
  assertEquals(beforeRec > 0 && beforeRec < residualRecIdx, true);
});
