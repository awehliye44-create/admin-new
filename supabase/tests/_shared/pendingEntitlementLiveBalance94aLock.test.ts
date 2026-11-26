/**
 * #93C / #94A — PENDING/RELEASE never inflate SQL or TS live wallet balance.
 *
 * Run: deno test --allow-read --no-check supabase/tests/_shared/pendingEntitlementLiveBalance94aLock.test.ts
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { BALANCE_EXCLUDED_LEDGER_TYPES } from "../../functions/_shared/onecabFinanceLedger.ts";
import { WALLET_BALANCE_EXCLUDED_LEDGER_TYPES } from "../../functions/_shared/walletBalanceSSOT.ts";
import { PAYOUT_ELIGIBLE_LEDGER_TYPES } from "../../functions/_shared/driverPayoutEligibilitySSOT.ts";
import {
  decideStaleCaptureReconcileAction,
  STALE_CAPTURE_OP_GRACE_MS,
} from "../../functions/_shared/reconcileStaleCaptureOperationsSSOT.ts";

Deno.test("#94A PENDING/RELEASE excluded from TS live balance and payout eligibility", () => {
  assertEquals(
    (BALANCE_EXCLUDED_LEDGER_TYPES as readonly string[]).includes("TRIP_EARNING_PENDING"),
    true,
  );
  assertEquals(
    (BALANCE_EXCLUDED_LEDGER_TYPES as readonly string[]).includes("TRIP_EARNING_PENDING_RELEASE"),
    true,
  );
  assertEquals(WALLET_BALANCE_EXCLUDED_LEDGER_TYPES.has("TRIP_EARNING_PENDING"), true);
  assertEquals(WALLET_BALANCE_EXCLUDED_LEDGER_TYPES.has("TRIP_EARNING_PENDING_RELEASE"), true);
  assertEquals(PAYOUT_ELIGIBLE_LEDGER_TYPES.has("TRIP_EARNING_PENDING"), false);
  assertEquals(PAYOUT_ELIGIBLE_LEDGER_TYPES.has("TRIP_EARNING_PENDING_RELEASE"), false);
});

Deno.test("#94A migration excludes PENDING from driver_wallet_live_balance_pence", async () => {
  const mig = await Deno.readTextFile(
    new URL(
      "../../migrations/20270301190000_pending_entitlement_live_balance_exclude_94a.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(mig, "TRIP_EARNING_PENDING");
  assertStringIncludes(mig, "TRIP_EARNING_PENDING_RELEASE");
  assertStringIncludes(mig, "driver_wallet_live_balance_pence");
  assertStringIncludes(mig, "PAYOUT_RESERVATION_HOLD");
});

Deno.test("#94A missing-TEN candidates use payment session capture, not trip.payment_status alone", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/missingTripEarningNetRecoverySSOT.ts", import.meta.url),
  );
  assertStringIncludes(src, 'from("payment_sessions")');
  assertStringIncludes(src, "captured_amount_pence");
  assertStringIncludes(src, "Oldest unresolved first");
  // Must not reintroduce trip.payment_status=captured as the sole candidate filter.
  assertEquals(src.includes('.eq("payment_status", "captured")'), false);
});

Deno.test("#94A stale CAPTURE reconcile: GET-only decisions", () => {
  assertEquals(
    decideStaleCaptureReconcileAction({
      priorState: "CAPTURE_UNKNOWN",
      orderState: "COMPLETED",
      confirmedCapturePence: 500,
      requestedAmountPence: 500,
      ageMs: STALE_CAPTURE_OP_GRACE_MS + 1,
    }).action,
    "FULLY_CAPTURED",
  );
  assertEquals(
    decideStaleCaptureReconcileAction({
      priorState: "CAPTURE_PENDING",
      orderState: "COMPLETED",
      confirmedCapturePence: 300,
      requestedAmountPence: 500,
      ageMs: STALE_CAPTURE_OP_GRACE_MS + 1,
    }).action,
    "PARTIALLY_CAPTURED",
  );
  assertEquals(
    decideStaleCaptureReconcileAction({
      priorState: "CAPTURE_REQUESTED",
      orderState: "AUTHORISED",
      confirmedCapturePence: null,
      requestedAmountPence: 500,
      ageMs: STALE_CAPTURE_OP_GRACE_MS + 1,
    }).action,
    "CAPTURE_FAILED",
  );
  assertEquals(
    decideStaleCaptureReconcileAction({
      priorState: "CAPTURE_UNKNOWN",
      orderState: "PROCESSING",
      confirmedCapturePence: null,
      requestedAmountPence: 500,
      ageMs: STALE_CAPTURE_OP_GRACE_MS + 1,
    }).action,
    "LEFT_ALONE",
  );
  // Inside grace — do not fail closed yet.
  assertEquals(
    decideStaleCaptureReconcileAction({
      priorState: "CAPTURE_REQUESTED",
      orderState: "AUTHORISED",
      confirmedCapturePence: null,
      requestedAmountPence: 500,
      ageMs: 1_000,
    }).action,
    "LEFT_ALONE",
  );
});

Deno.test("#94A sweep wires integrity + stale capture reconcile stages", async () => {
  const sweep = await Deno.readTextFile(
    new URL("../../functions/sweep-revolut-stale-holds/index.ts", import.meta.url),
  );
  assertStringIncludes(sweep, "recoverPostCaptureLedgerIntegrityBatch");
  assertStringIncludes(sweep, "reconcileStaleCaptureOperationsBatch");
  assertStringIncludes(sweep, "post_capture_ledger_integrity_94a");
  assertStringIncludes(sweep, "stale_capture_op_reconcile_94a");
});
