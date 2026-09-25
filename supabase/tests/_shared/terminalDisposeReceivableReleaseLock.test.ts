/**
 * Lock: terminal dispose (search expiry / NO_FEE_FULL_RELEASE) must reconcile
 * customer receivables from the FRESH provider GET/cancel result.
 *
 * Regression (CU040 Phase-A 2026-09-25):
 *   AUTHORISED 782 → search expiry → CANCELLED / released 782
 *   but allocations stayed RESERVED (30+6) because reconcileSessionCancelled
 *   never called reconcileReceivablesOnAbandonOrCancel.
 *
 * If these fail, fix the code — never delete or soften this lock.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CUSTOMER_RECEIVABLE_STATUS,
  planFoldReceivablesIntoPreauth,
  planReleaseOnCancel,
  planSettleFromProviderEvidence,
} from "../../functions/_shared/customerReceivableSSOT.ts";

const disposePath = new URL(
  "../../functions/_shared/terminalTripPaymentDisposition.ts",
  import.meta.url,
);
const releaseHoldPath = new URL(
  "../../functions/release-terminal-trip-hold/index.ts",
  import.meta.url,
);
const lifecyclePath = new URL(
  "../../functions/_shared/customerReceivableLifecycle.ts",
  import.meta.url,
);

Deno.test("1. dispose wires reconcileReceivablesOnAbandonOrCancel after provider reconcile", async () => {
  const src = await Deno.readTextFile(disposePath);
  assertStringIncludes(src, 'from "./customerReceivableLifecycle.ts"');
  assertStringIncludes(src, "reconcileReceivablesOnAbandonOrCancel");
  // Fresh provider state from GET/cancel — not a stale pre-dispose read.
  assertStringIncludes(src, "provider_state: stateFresh");
  assertStringIncludes(src, "amountFromProviderGet: true");
});

Deno.test("2. release-terminal-trip-hold owns search-expiry dispose entry", async () => {
  const src = await Deno.readTextFile(releaseHoldPath);
  assertStringIncludes(src, "disposeTerminalTripPayment");
  assertStringIncludes(src, "assertCronOrServiceRoleAuth");
});

Deno.test("3. CANCELLED + zero capture → RELEASE (search-expiry contract)", () => {
  const d = planReleaseOnCancel({
    provider_order_id: "6ab60640-10cc-a6b0-8430-c151523f3398",
    provider_state: "CANCELLED",
    has_capture: false,
    hold_safely_released: true,
  });
  assertEquals(d.action, "RELEASE");
});

Deno.test("4. AUTHORISED without safe release → KEEP_RESERVED", () => {
  const d = planReleaseOnCancel({
    provider_order_id: "order-auth",
    provider_state: "AUTHORISED",
    has_capture: false,
    hold_safely_released: false,
  });
  assertEquals(d.action, "KEEP_RESERVED");
  assertEquals(d.reason, "authorised_awaiting_safe_hold_release");
});

Deno.test("5. UNKNOWN after search expiry → KEEP_RESERVED (reconcile only)", () => {
  const d = planReleaseOnCancel({
    provider_order_id: "order-unk",
    provider_state: "UNKNOWN",
    has_capture: false,
    hold_safely_released: false,
  });
  assertEquals(d.action, "KEEP_RESERVED");
  assertEquals(d.reason, "provider_unknown_reconcile_only");
});

Deno.test("6. cancel timeout (UNKNOWN) never blindly RELEASE even if local cancel claimed success", () => {
  const d = planReleaseOnCancel({
    provider_order_id: "order-timeout",
    provider_state: "UNKNOWN",
    has_capture: false,
    hold_safely_released: true, // local cancel attempt — still fail closed on UNKNOWN
  });
  assertEquals(d.action, "KEEP_RESERVED");
});

Deno.test("7. COMPLETED capture → SETTLE (never OPEN/release financially applied)", () => {
  const d = planReleaseOnCancel({
    provider_order_id: "order-cap",
    provider_state: "COMPLETED",
    has_capture: true,
    hold_safely_released: true,
  });
  assertEquals(d.action, "SETTLE");
  const gate = planSettleFromProviderEvidence({
    payment_session_id: "sess-1",
    evidence: {
      orderId: "order-cap",
      terminalState: "COMPLETED",
      confirmedCapturedPence: 200,
      amountFromProviderGet: true,
    },
  });
  assertEquals(gate.ok, true);
  assertEquals(gate.confirmed_captured_pence, 200);
});

Deno.test("8. AUTHORISED alone must not settle", () => {
  const gate = planSettleFromProviderEvidence({
    payment_session_id: "sess-1",
    evidence: {
      orderId: "order-auth",
      terminalState: "AUTHORISED",
      confirmedCapturedPence: 782,
      amountFromProviderGet: true,
    },
  });
  assertEquals(gate.ok, false);
});

const CID = "6818f4c3-2645-4bef-897a-30d0abe199bd";

Deno.test("9. stale RESERVED rows are not folded into a new booking (OPEN only)", () => {
  const plan = planFoldReceivablesIntoPreauth({
    ride_fare_pence: 746,
    buffer_pence: 0,
    open_receivables: [
      {
        id: "recv-30",
        customer_id: CID,
        outstanding_amount_pence: 30,
        status: CUSTOMER_RECEIVABLE_STATUS.RESERVED,
        created_at: "2026-09-23T00:00:00Z",
        currency: "gbp",
        source_trip_id: "mk012",
        idempotency_key: "k30",
      },
      {
        id: "recv-6",
        customer_id: CID,
        outstanding_amount_pence: 6,
        status: CUSTOMER_RECEIVABLE_STATUS.RESERVED,
        created_at: "2026-09-23T00:00:01Z",
        currency: "gbp",
        source_trip_id: "mk017",
        idempotency_key: "k6",
      },
    ],
  });
  assertEquals(plan.receivables_total_pence, 0);
  assertEquals(plan.authorised_amount_pence, 746);
});

Deno.test("10. after RELEASE→OPEN, fold includes 36p", () => {
  const plan = planFoldReceivablesIntoPreauth({
    ride_fare_pence: 746,
    buffer_pence: 0,
    open_receivables: [
      {
        id: "recv-30",
        customer_id: CID,
        outstanding_amount_pence: 30,
        status: CUSTOMER_RECEIVABLE_STATUS.OPEN,
        created_at: "2026-09-23T00:00:00Z",
        currency: "gbp",
        source_trip_id: "mk012",
        idempotency_key: "k30",
      },
      {
        id: "recv-6",
        customer_id: CID,
        outstanding_amount_pence: 6,
        status: CUSTOMER_RECEIVABLE_STATUS.OPEN,
        created_at: "2026-09-23T00:00:01Z",
        currency: "gbp",
        source_trip_id: "mk017",
        idempotency_key: "k6",
      },
    ],
  });
  assertEquals(plan.receivables_total_pence, 36);
  assertEquals(plan.authorised_amount_pence, 782);
});

Deno.test("11. lifecycle exports reconcileReceivablesOnAbandonOrCancel alias", async () => {
  const src = await Deno.readTextFile(lifecyclePath);
  assertStringIncludes(src, "export async function reconcileReceivablesOnAbandonOrCancel");
  assertStringIncludes(src, "customer_receivable_release_reservations");
});

Deno.test("12. dispose does not touch wallet/TEN/commission/payout writers", async () => {
  const src = await Deno.readTextFile(disposePath);
  assertEquals(src.includes("driver_wallet_ledger"), false);
  assertEquals(src.includes("customer_wallet_ledger"), false);
  assertEquals(src.includes("driver_earning_settlement"), false);
  assertEquals(src.includes("commission_wallet"), false);
  assertEquals(/createTripEarningsNotification|writeTen\b/.test(src), false);
});

Deno.test("13. fee decision maps expired search → NO_FEE_FULL_RELEASE / search_or_rematch_expired", async () => {
  const feeSrc = await Deno.readTextFile(
    new URL("../../functions/_shared/terminalFeeDecisionSSOT.ts", import.meta.url),
  );
  assertStringIncludes(feeSrc, "NO_FEE_FULL_RELEASE");
  assertStringIncludes(feeSrc, "search_or_rematch_expired");
});
