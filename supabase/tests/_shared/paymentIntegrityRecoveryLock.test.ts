/**
 * D — Automatic recovery verification locks (payment integrity follow-up).
 * Demonstrates durable recovery paths without mutating production ledgers.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  mayRetryWalletPosting,
  paymentSessionAllowsWalletPosting,
} from "../../functions/_shared/postCaptureSettlementBoundary.ts";
import {
  INCOMPLETE_SETTLEMENT_RECOVERY_ACTIVATED_AT_MS,
  MISSING_TEN_RECOVERY_REASON,
} from "../../functions/_shared/missingTripEarningNetRecoverySSOT.ts";
import {
  resolveProviderConfirmedCapturePence,
} from "../../functions/_shared/providerConfirmedCaptureEvidenceSSOT.ts";

Deno.test("D: residual release after capture still allows wallet gate", () => {
  assertEquals(paymentSessionAllowsWalletPosting({
    status: "captured",
    provider_state: "COMPLETED",
    captured_amount_pence: 2940,
    provider_state_verified_at: "2026-11-22T21:19:35.946Z",
    hold_release_state: "released",
    released_amount_pence: null,
  }), true);
});

Deno.test("D: confirmed refund still blocks wallet gate", () => {
  assertEquals(paymentSessionAllowsWalletPosting({
    status: "captured",
    provider_state: "COMPLETED",
    captured_amount_pence: 2940,
    provider_state_verified_at: "2026-11-22T21:19:35.946Z",
    refunded_amount_pence: 100,
  }), false);
});

Deno.test("D: incomplete settlement recovery bypasses unset activation detect-only", () => {
  assertEquals(mayRetryWalletPosting({
    capture_completed_at_iso: "2026-11-22T21:19:34.764Z",
    activated_at_ms: null,
  }), false);
  assertEquals(mayRetryWalletPosting({
    capture_completed_at_iso: "2026-11-22T21:19:34.764Z",
    activated_at_ms: INCOMPLETE_SETTLEMENT_RECOVERY_ACTIVATED_AT_MS,
  }), true);
  assertEquals(
    MISSING_TEN_RECOVERY_REASON,
    "PROVIDER_CONFIRMED_CAPTURE_MISSING_TRIP_EARNING_NET",
  );
});

Deno.test("D: provider COMPLETED amount is authoritative confirmed capture", () => {
  assertEquals(
    resolveProviderConfirmedCapturePence({
      providerState: "COMPLETED",
      providerCapturedPence: 903,
      sessionStatus: "captured",
      sessionCapturedPence: 903,
      paymentCapturedPence: 903,
    }),
    903,
  );
  // Session captured status with amount is also confirmed evidence.
  assertEquals(
    resolveProviderConfirmedCapturePence({
      providerState: "AUTHORISED",
      providerCapturedPence: null,
      sessionStatus: "captured",
      sessionCapturedPence: 2940,
      paymentCapturedPence: null,
    }),
    2940,
  );
  // Authorised hold without session/provider capture evidence → 0.
  assertEquals(
    resolveProviderConfirmedCapturePence({
      providerState: "AUTHORISED",
      providerCapturedPence: null,
      sessionStatus: "authorised_hold",
      sessionCapturedPence: null,
      paymentCapturedPence: null,
    }),
    0,
  );
});

Deno.test("D: settlement-before-residual + missing-TEN sweep wired in sources", async () => {
  const captureSrc = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutCompletionCapture.ts", import.meta.url),
  );
  const sweepSrc = await Deno.readTextFile(
    new URL("../../functions/sweep-revolut-stale-holds/index.ts", import.meta.url),
  );
  assertEquals(
    captureSrc.includes("Settlement before residual evidence (MK-261122-001 residual race)"),
    true,
  );
  assertEquals(sweepSrc.includes("sweepRecoverMissingTripEarningNet"), true);
  assertEquals(sweepSrc.includes("missing_ten_recovery"), true);
  // Abandoned CAPTURING lock: completion source releases lock_busy / abandon path present.
  assertEquals(
    captureSrc.includes("abandon") || captureSrc.includes("lock_busy")
      || captureSrc.includes("releasePaymentSessionFinancialLock"),
    true,
  );
});
