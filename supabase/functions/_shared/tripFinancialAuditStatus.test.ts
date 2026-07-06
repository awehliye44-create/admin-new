import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  deriveDriverPayoutAuditStatus,
  deriveOnecabCommissionAuditStatus,
  deriveProviderAuditStatus,
  deriveTripFinancialAuditStatuses,
} from "./tripFinancialAuditStatus.ts";

const cashTrip = {
  id: "t-cash",
  payment_method: "CASH",
  commission_pence: 222,
  capture_amount_pence: 0,
  refund_amount_pence: 0,
};

const cardTrip = {
  id: "t-card",
  payment_method: "card",
  commission_pence: 72,
  capture_amount_pence: 480,
  refund_amount_pence: 0,
  stripe_settlement_verified: false,
  stripe_payment_intent_id: "pi_123",
  payment_status: "captured",
};

Deno.test("cash trip — driver collected, commission receivable, cash provider", () => {
  const input = {
    trip: cashTrip,
    ledger: [{ type: "CASH_COMMISSION_DEBT", amount_pence: -222 }],
  };
  assertEquals(deriveDriverPayoutAuditStatus(input).label, "Already Collected");
  assertEquals(deriveDriverPayoutAuditStatus(input).tone, "green");
  assertEquals(deriveOnecabCommissionAuditStatus(input).label, "Receivable");
  assertEquals(deriveProviderAuditStatus(input).label, "Historical Legacy Trip");
  assertEquals(deriveProviderAuditStatus(input).tone, "gray");
});

Deno.test("cash trip never shows Captured or Settled", () => {
  const input = { trip: { ...cashTrip, stripe_settlement_verified: true, payment_status: "captured" } };
  assertEquals(deriveProviderAuditStatus(input).label, "Historical Legacy Trip");
});

Deno.test("card captured not paid out — awaiting payout, earned, captured", () => {
  const input = { trip: cardTrip, payouts: [] };
  const s = deriveTripFinancialAuditStatuses(input);
  assertEquals(s.driver_payout.label, "Awaiting Payout");
  assertEquals(s.driver_payout.tone, "yellow");
  assertEquals(s.onecab_commission.label, "Earned");
  assertEquals(s.provider.label, "Captured");
  assertEquals(s.provider.tone, "blue");
});

Deno.test("card captured with full debt recovery — no payout due", () => {
  const input = {
    trip: { ...cardTrip, driver_net_pence: 500 },
    payouts: [],
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 500 },
      { type: "DEBT_RECOVERY", amount_pence: -500 },
    ],
  };
  assertEquals(deriveDriverPayoutAuditStatus(input).label, "Debt recovered / No payout due");
  assertEquals(deriveDriverPayoutAuditStatus(input).tone, "blue");
});

Deno.test("card settled — provider settled", () => {
  const input = { trip: { ...cardTrip, stripe_settlement_verified: true } };
  assertEquals(deriveProviderAuditStatus(input).label, "Settled");
  assertEquals(deriveProviderAuditStatus(input).tone, "green");
});

Deno.test("card paid out — driver paid out", () => {
  const input = {
    trip: { ...cardTrip, stripe_settlement_verified: true },
    payouts: [{ status: "completed", driver_amount_pence: 408 }],
  };
  assertEquals(deriveDriverPayoutAuditStatus(input).label, "Paid Out");
  assertEquals(deriveDriverPayoutAuditStatus(input).tone, "green");
});

Deno.test("refund — reversed and refunded badges", () => {
  const input = {
    trip: { ...cardTrip, refund_amount_pence: 480 },
    payouts: [],
  };
  assertEquals(deriveDriverPayoutAuditStatus(input).label, "Reversed");
  assertEquals(deriveOnecabCommissionAuditStatus(input).label, "Reversed");
  assertEquals(deriveProviderAuditStatus(input).label, "Refunded");
});

Deno.test("dispute — on hold, under review, disputed", () => {
  const input = {
    trip: { ...cardTrip, payment_status: "disputed" },
    payouts: [],
  };
  assertEquals(deriveDriverPayoutAuditStatus(input).label, "On Hold");
  assertEquals(deriveOnecabCommissionAuditStatus(input).label, "Under Review");
  assertEquals(deriveProviderAuditStatus(input).label, "Disputed");
});

Deno.test("provider settled via balance transaction available_on", () => {
  const input = {
    trip: { ...cardTrip, stripe_settlement_verified: false },
    payment: {
      status: "captured",
      provider_status: "available",
      captured_amount_pence: 480,
      provider_available_on: "2020-01-01T00:00:00.000Z",
    },
    payouts: [],
  };
  assertEquals(deriveProviderAuditStatus(input).label, "Settled");
});

Deno.test("refund detected via refunded_at without amount", () => {
  const input = {
    trip: { ...cardTrip, refund_amount_pence: 0, refunded_at: "2026-01-01T00:00:00.000Z" },
    payouts: [],
  };
  assertEquals(deriveDriverPayoutAuditStatus(input).label, "Reversed");
  assertEquals(deriveProviderAuditStatus(input).label, "Refunded");
});

Deno.test("card pending capture — never shows generic awaiting settlement", () => {
  const input = {
    trip: {
      ...cardTrip,
      capture_amount_pence: 0,
      payment_status: "pending_capture",
      stripe_payment_intent_id: "pi_pending",
    },
    payment: { status: "requires_capture", provider_status: null, captured_amount_pence: 0 },
    payouts: [],
  };
  assertEquals(deriveProviderAuditStatus(input).label, "Pending Capture");
  assertEquals(deriveProviderAuditStatus(input).tone, "yellow");
});
