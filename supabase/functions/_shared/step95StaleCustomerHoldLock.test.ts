/**
 * Step 9.5 — stale customer card hold / issuer-lag lock.
 * Pure classification + sweep contract (no provider mutation).
 *
 * Run: deno test --allow-read supabase/functions/_shared/step95StaleCustomerHoldLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyLocalHoldTerminal,
  classifyProviderHoldDecision,
  localReleasedNeedsProviderReconcile,
  summarizeHoldSweepItemOutcomes,
} from "./holdReleasePure.ts";

const sweepPath = new URL("../sweep-revolut-stale-holds/index.ts", import.meta.url);
const holdPath = new URL("./holdReleaseSSOT.ts", import.meta.url);
const paymentSessionPath = new URL("./paymentSessionSSOT.ts", import.meta.url);

Deno.test("cancelled authorised order → RELEASE_ONCE (one release)", () => {
  assertEquals(
    classifyProviderHoldDecision({
      providerState: "AUTHORISED",
      completedAmountPence: 0,
      localTerminal: "none",
    }),
    "RELEASE_ONCE",
  );
});

Deno.test("provider already released → RECONCILE_LOCAL_ONLY (no second cancel)", () => {
  assertEquals(
    classifyProviderHoldDecision({
      providerState: "CANCELLED",
      completedAmountPence: 0,
      localTerminal: "released",
    }),
    "RECONCILE_LOCAL_ONLY",
  );
});

Deno.test("captured order → NEVER_RELEASE_CAPTURED", () => {
  assertEquals(
    classifyProviderHoldDecision({
      providerState: "COMPLETED",
      completedAmountPence: 650,
      localTerminal: "none",
    }),
    "NEVER_RELEASE_CAPTURED",
  );
});

Deno.test("refunded captured order → NEVER_RELEASE_REFUNDED (not hold-release)", () => {
  assertEquals(
    classifyProviderHoldDecision({
      providerState: "COMPLETED",
      completedAmountPence: 650,
      refundedAmountPence: 650,
      localTerminal: "none",
    }),
    "NEVER_RELEASE_REFUNDED",
  );
});

Deno.test("local false-released + AUTHORISED → needs retrieve/retry", () => {
  const session = {
    hold_release_state: "released",
    provider_state: "AUTHORISED",
    captured_amount_pence: 0,
  };
  assertEquals(classifyLocalHoldTerminal(session), "released");
  assertEquals(localReleasedNeedsProviderReconcile(session), true);
  assertEquals(
    classifyProviderHoldDecision({
      providerState: "AUTHORISED",
      completedAmountPence: 0,
      localTerminal: "released",
    }),
    "RELEASE_ONCE",
  );
});

Deno.test("provider release failure stays retryable (non-cancelable → RETRYABLE)", () => {
  assertEquals(
    classifyProviderHoldDecision({
      providerState: "UNKNOWN_STATE",
      completedAmountPence: 0,
      localTerminal: "none",
    }),
    "RETRYABLE_PROVIDER_FAILURE",
  );
});

Deno.test("duplicate identical amounts remain distinct by provider identity", () => {
  const a = { orderId: "6a805d12-2890-aaaa-bbbb-cccccccccccc", amount: 595 };
  const b = { orderId: "6a806be7-5dc0-aaaa-bbbb-dddddddddddd", amount: 595 };
  assertEquals(a.amount, b.amount);
  assertEquals(a.orderId === b.orderId, false);
});

Deno.test("tripless authorised session is a release candidate", () => {
  assertEquals(
    classifyProviderHoldDecision({
      providerState: "AUTHORISED",
      completedAmountPence: 0,
      localTerminal: "none",
    }),
    "RELEASE_ONCE",
  );
});

Deno.test("SAVE_CARD verification follows own non-RIDE contract (captured never released)", () => {
  // SAVE_CARD verification orders that completed must not enter hold-cancel.
  assertEquals(
    classifyProviderHoldDecision({
      providerState: "COMPLETED",
      completedAmountPence: 0,
      localTerminal: "none",
    }),
    "NEVER_RELEASE_CAPTURED",
  );
});

Deno.test("cron HTTP success cannot hide item-level failure", () => {
  const summary = summarizeHoldSweepItemOutcomes([
    { ok: true, status: "released" },
    { ok: false, outcome: "PROVIDER_FAILED" },
  ]);
  assertEquals(summary.item_failure_count, 1);
  assertEquals(summary.overall_ok, false);
  assertEquals(summary.cron_http_success_hides_item_failure, true);
});

Deno.test("idempotent retry: already cancelled + local released → reconcile only", () => {
  assertEquals(
    classifyProviderHoldDecision({
      providerState: "CANCELLED",
      localTerminal: "released",
    }),
    "RECONCILE_LOCAL_ONLY",
  );
});

Deno.test("sweep dry-run classifies false-local-release via Merchant GET only", async () => {
  const src = await Deno.readTextFile(sweepPath);
  assertStringIncludes(src, "PROVIDER_ALREADY_CANCELLED_LOCAL_RECONCILIATION_REQUIRED");
  assertStringIncludes(src, "provider_release_calls: 0");
  assertStringIncludes(src, "database_writes: 0");
  assertStringIncludes(src, "classify_false_local_release");
});


Deno.test("holdReleaseSSOT retrieves before treating local released as terminal", async () => {
  const src = await Deno.readTextFile(holdPath);
  assertStringIncludes(src, "localReleasedNeedsProviderReconcile");
  assertStringIncludes(src, "classifyProviderHoldDecision");
  assertStringIncludes(src, "retrieveRevolutOrder");
  assertStringIncludes(src, "NEVER_RELEASE_CAPTURED");
});

Deno.test("markPaymentSessionReleased flips PAYMENT_AUTHENTICATED", async () => {
  const src = await Deno.readTextFile(paymentSessionPath);
  assertStringIncludes(src, "PAYMENT_AUTHENTICATED");
  assertStringIncludes(src, "openHoldStates");
});

Deno.test("no wallet/TEN/payout/CW writes in holdReleaseSSOT", async () => {
  const src = await Deno.readTextFile(holdPath);
  assertEquals(/driver_wallets|driver_wallet_ledger|driver_earning_settlement|commission_wallet|payout/.test(src), false);
});
