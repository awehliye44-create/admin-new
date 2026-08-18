import { describe, expect, it } from "vitest";
import {
  PAYOUT_ELIGIBILITY_STATUS,
  aggregateDriverPayoutEligibility,
  evaluateLedgerEntryEligibility,
  isPayoutClearedForPlatformCollected,
  requiresPlatformCollectedClearing,
  type LedgerEligibilityEvidence,
} from "../../../shared/driverPayoutEligibilitySSOT";
import { buildDriverWalletPeriodKpis } from "@shared/driverWalletPeriodKpisSSOT";
import { buildDriverWalletSummaryResponse } from "@/lib/driverWalletPeriodWidgetsSSOT";
import { displayDriverWalletSsotBalances } from "@/lib/driverWalletSsotBalances";

const NOW_MS = Date.parse("2026-08-15T16:00:00.000Z");
const FRESH_CAPTURE = "2026-08-15T15:00:00.000Z";
const CLEARED_AT = "2026-08-13T12:00:00.000Z";
const POLICY_27H = { now_ms: NOW_MS, clearing_delay_hours: 27 };

function earning(overrides: Partial<LedgerEligibilityEvidence> = {}): LedgerEligibilityEvidence {
  return {
    ledger_entry_id: "earn-2239",
    trip_id: "trip-2239",
    ledger_type: "TRIP_EARNING_NET",
    amount_pence: 2239,
    trip_exists: true,
    payment_session_id: "ps-2239",
    captured_amount_pence: 2634,
    canonical_driver_net_pence: 2239,
    fr_trip_status: "BALANCED",
    refunded_amount_pence: 0,
    des_present: false,
    payment_collection_model: "PLATFORM_COLLECTED",
    captured_at: FRESH_CAPTURE,
    earning_credited_at: FRESH_CAPTURE,
    ...overrides,
  };
}

function uncleared(overrides: Partial<LedgerEligibilityEvidence> = {}) {
  return earning({
    provider_available_on: null,
    settled_at: null,
    captured_at: FRESH_CAPTURE,
    earning_credited_at: FRESH_CAPTURE,
    ...overrides,
  });
}

function cleared(overrides: Partial<LedgerEligibilityEvidence> = {}) {
  return earning({
    provider_available_on: CLEARED_AT,
    captured_at: CLEARED_AT,
    earning_credited_at: CLEARED_AT,
    ...overrides,
  });
}

describe("driver wallet payout clearing lock", () => {
  it("1. captured but uncleared PLATFORM_COLLECTED → Pending, not Available", () => {
    const r = evaluateLedgerEntryEligibility(uncleared(), POLICY_27H);
    expect(r.status).toBe(PAYOUT_ELIGIBILITY_STATUS.SETTLEMENT_PENDING);
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 2239,
      entries: [uncleared()],
      clearing_policy: POLICY_27H,
    });
    expect(agg).toMatchObject({
      live_balance_pence: 2239,
      pending_balance_pence: 2239,
      available_balance_pence: 0,
    });
  });

  it("2. payout-cleared → Available", () => {
    const r = evaluateLedgerEntryEligibility(cleared(), POLICY_27H);
    expect(r.status).toBe(PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE);
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 2239,
      entries: [cleared()],
      clearing_policy: POLICY_27H,
    });
    expect(agg).toMatchObject({
      live_balance_pence: 2239,
      pending_balance_pence: 0,
      available_balance_pence: 2239,
    });
  });

  it("3–5. Pending → Available does not alter Today / This Week / Annual earnings", () => {
    const ledger = [
      {
        type: "TRIP_EARNING_NET",
        amount_pence: 2239,
        related_trip_id: "trip-2239",
        created_at: FRESH_CAPTURE,
        economic_earned_at: FRESH_CAPTURE,
      },
    ];
    const pendingAgg = aggregateDriverPayoutEligibility({
      live_balance_pence: 2239,
      entries: [uncleared()],
      clearing_policy: POLICY_27H,
    });
    const availableAgg = aggregateDriverPayoutEligibility({
      live_balance_pence: 2239,
      entries: [cleared()],
      clearing_policy: POLICY_27H,
    });
    expect(pendingAgg.live_balance_pence).toBe(availableAgg.live_balance_pence);

    const pendingKpis = buildDriverWalletPeriodKpis(ledger, {
      pendingEarningsPence: pendingAgg.pending_balance_pence,
      now: new Date(NOW_MS),
    });
    const availableKpis = buildDriverWalletPeriodKpis(ledger, {
      pendingEarningsPence: availableAgg.pending_balance_pence,
      now: new Date(NOW_MS),
    });
    expect(pendingKpis.today_earnings_pence).toBe(availableKpis.today_earnings_pence);
    expect(pendingKpis.week_earnings_pence).toBe(availableKpis.week_earnings_pence);
    expect(pendingKpis.year_earnings_pence).toBe(availableKpis.year_earnings_pence);
    expect(pendingKpis.lifetime_earnings_pence).toBe(availableKpis.lifetime_earnings_pence);
    expect(pendingKpis.lifetime_earnings_pence).toBe(2239);

    const pendingWidgets = buildDriverWalletSummaryResponse({
      periodKey: "today",
      periodFrom: "2026-08-15T00:00:00.000Z",
      periodTo: "2026-08-15T23:59:59.999Z",
      account: {
        live_balance_pence: pendingAgg.live_balance_pence,
        available_balance_pence: pendingAgg.available_balance_pence,
        pending_balance_pence: pendingAgg.pending_balance_pence,
        outstanding_debt_pence: 0,
        annual_driver_earnings_pence: 2239,
      },
      ledger,
    });
    const availableWidgets = buildDriverWalletSummaryResponse({
      periodKey: "today",
      periodFrom: "2026-08-15T00:00:00.000Z",
      periodTo: "2026-08-15T23:59:59.999Z",
      account: {
        live_balance_pence: availableAgg.live_balance_pence,
        available_balance_pence: availableAgg.available_balance_pence,
        pending_balance_pence: availableAgg.pending_balance_pence,
        outstanding_debt_pence: 0,
        annual_driver_earnings_pence: 2239,
      },
      ledger,
    });
    expect(pendingWidgets.summary.driver_net_earnings_pence).toBe(
      availableWidgets.summary.driver_net_earnings_pence,
    );
    expect(pendingWidgets.account.annual_driver_earnings_pence).toBe(2239);
    expect(availableWidgets.account.annual_driver_earnings_pence).toBe(2239);
  });

  it("6. Pending → Available creates no second ledger earning", () => {
    const before = [uncleared()];
    const after = [cleared({ ledger_entry_id: before[0]!.ledger_entry_id })];
    expect(after).toHaveLength(before.length);
    expect(after[0]!.ledger_entry_id).toBe(before[0]!.ledger_entry_id);
    expect(after[0]!.amount_pence).toBe(before[0]!.amount_pence);
  });

  it("7. Driver app keys equal Admin SSOT keys", () => {
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 2239,
      entries: [uncleared()],
      clearing_policy: POLICY_27H,
    });
    expect(agg).toEqual(expect.objectContaining({
      live_balance_pence: 2239,
      pending_balance_pence: 2239,
      available_balance_pence: 0,
      withdrawal_in_progress_pence: 0,
    }));
  });

  it("8. withdrawal cannot consume Pending", () => {
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 2239,
      entries: [uncleared()],
      clearing_policy: POLICY_27H,
    });
    const requested = 2239;
    expect(requested <= agg.available_balance_pence).toBe(false);
    expect(agg.available_balance_pence).toBe(0);
  });

  it("9. reservation is separate from settlement Pending", () => {
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 2239,
      reserved_payout_pence: 500,
      entries: [uncleared()],
      clearing_policy: POLICY_27H,
    });
    expect(agg.pending_balance_pence).toBe(2239);
    expect(agg.withdrawal_in_progress_pence).toBe(500);
    expect(agg.available_balance_pence).toBe(0);
  });

  it("10. refund before availability holds the earning", () => {
    const r = evaluateLedgerEntryEligibility(
      uncleared({ refunded_amount_pence: 2634 }),
      POLICY_27H,
    );
    expect(r.status).toBe(PAYOUT_ELIGIBILITY_STATUS.REFUND_HOLD);
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 0,
      entries: [uncleared({ refunded_amount_pence: 2634 })],
      clearing_policy: POLICY_27H,
    });
    expect(agg.available_balance_pence).toBe(0);
    expect(agg.pending_balance_pence).toBe(0);
  });

  it("11. refund after availability holds the earning", () => {
    const r = evaluateLedgerEntryEligibility(
      cleared({ refunded_amount_pence: 2634 }),
      POLICY_27H,
    );
    expect(r.status).toBe(PAYOUT_ELIGIBILITY_STATUS.REFUND_HOLD);
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 0,
      entries: [cleared({ refunded_amount_pence: 2634 })],
      clearing_policy: POLICY_27H,
    });
    expect(agg.available_balance_pence).toBe(0);
  });

  it("12. chargeback is held and not Available", () => {
    const r = evaluateLedgerEntryEligibility(
      uncleared({ chargeback_hold: true }),
      POLICY_27H,
    );
    expect(r.status).toBe(PAYOUT_ELIGIBILITY_STATUS.CHARGEBACK_HOLD);
  });

  it("13. partial capture is CAPTURE_MISMATCH, not Available", () => {
    const r = evaluateLedgerEntryEligibility(
      uncleared({ captured_amount_pence: 1000, canonical_driver_net_pence: 2239 }),
      POLICY_27H,
    );
    expect(r.status).toBe(PAYOUT_ELIGIBILITY_STATUS.CAPTURE_MISMATCH);
  });

  it("14. incremental-auth / capture failure stays CAPTURE_PENDING", () => {
    const authorisedOnly = evaluateLedgerEntryEligibility(
      uncleared({
        captured_amount_pence: null,
        payment_session_id: "ps-auth",
      }),
      POLICY_27H,
    );
    expect(authorisedOnly.status).toBe(PAYOUT_ELIGIBILITY_STATUS.CAPTURE_PENDING);
    const captureFail = evaluateLedgerEntryEligibility(
      uncleared({ captured_amount_pence: 0 }),
      POLICY_27H,
    );
    expect(captureFail.status).toBe(PAYOUT_ELIGIBILITY_STATUS.CAPTURE_PENDING);
  });

  it("15. historical captured-but-uncleared reclassifies Available → Pending without new rows", () => {
    const historical = uncleared({
      ledger_entry_id: "hist-773",
      trip_id: "trip-773",
      amount_pence: 773,
      canonical_driver_net_pence: 773,
      captured_amount_pence: 910,
      captured_at: FRESH_CAPTURE,
    });
    const oldRuleWouldHaveBeenEligible = historical.captured_amount_pence! >= historical.canonical_driver_net_pence!;
    expect(oldRuleWouldHaveBeenEligible).toBe(true);
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 773,
      entries: [historical],
      clearing_policy: POLICY_27H,
    });
    expect(agg.available_balance_pence).toBe(0);
    expect(agg.pending_balance_pence).toBe(773);
    expect(agg.live_balance_pence).toBe(773);
    expect(agg.eligible_entries).toHaveLength(0);
  });

  it("16. payout consumes Available exactly once", () => {
    const first = evaluateLedgerEntryEligibility(
      cleared({ allocated_to_payout: true }),
      POLICY_27H,
    );
    expect(first.status).toBe(PAYOUT_ELIGIBILITY_STATUS.PAYOUT_ALLOCATED);
    expect(first.payable_pence).toBe(0);
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 0,
      entries: [cleared({ allocated_to_payout: true })],
      clearing_policy: POLICY_27H,
    });
    expect(agg.available_balance_pence).toBe(0);
    expect(agg.eligible_entries).toHaveLength(0);
  });

  it("DRIVER_COLLECTED_COMMISSION_WALLET credits never become payout-eligible", () => {
    expect(requiresPlatformCollectedClearing({
      financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
      payment_method: "cash",
    })).toBe(false);
    const r = evaluateLedgerEntryEligibility(
      uncleared({
        payment_collection_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
        financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
        payment_method: "cash",
      }),
      POLICY_27H,
    );
    expect(r.status).toBe(PAYOUT_ELIGIBILITY_STATUS.UNKNOWN_ELIGIBILITY_ERROR);
    expect(r.payable_pence).toBe(0);
  });

  it("capture timestamp alone is not sufficient; delay fallback is backend-owned", () => {
    expect(isPayoutClearedForPlatformCollected({
      payment_collection_model: "PLATFORM_COLLECTED",
      captured_at: FRESH_CAPTURE,
    }, POLICY_27H)).toBe(false);
    expect(isPayoutClearedForPlatformCollected({
      payment_collection_model: "PLATFORM_COLLECTED",
      captured_at: "2026-08-13T12:00:00.000Z",
    }, POLICY_27H)).toBe(true);
    expect(isPayoutClearedForPlatformCollected({
      payment_collection_model: "PLATFORM_COLLECTED",
      provider_state: "COMPLETED",
      captured_at: FRESH_CAPTURE,
    }, POLICY_27H)).toBe(false);
    expect(isPayoutClearedForPlatformCollected({
      payment_collection_model: "PLATFORM_COLLECTED",
      provider_available_on: CLEARED_AT,
    }, POLICY_27H)).toBe(true);
  });

  it("DES settlement_status=settled is capture companion, not merchant clearing", () => {
    const r = evaluateLedgerEntryEligibility(
      uncleared({
        des_present: true,
        des_settlement_status: "settled",
        settled_at: FRESH_CAPTURE,
      }),
      POLICY_27H,
    );
    expect(r.status).toBe(PAYOUT_ELIGIBILITY_STATUS.SETTLEMENT_PENDING);
  });

  it("each driver Pending is own completed captured unpaid earnings — not cancelled, not paid out", () => {
    const mk0001Pending = uncleared({
      trip_status: "completed",
      ledger_entry_id: "mk1-a",
      trip_id: "t-mk1-a",
      amount_pence: 565,
      canonical_driver_net_pence: 565,
      captured_amount_pence: 650,
    });
    const mk0001Cancelled = uncleared({
      trip_status: "cancelled",
      ledger_entry_id: "mk1-cancel",
      trip_id: "t-mk1-cancel",
      amount_pence: 425,
      canonical_driver_net_pence: 425,
      captured_amount_pence: 500,
    });
    const mk0001PaidOut = uncleared({
      trip_status: "completed",
      ledger_entry_id: "mk1-paid",
      trip_id: "t-mk1-paid",
      amount_pence: 408,
      canonical_driver_net_pence: 408,
      captured_amount_pence: 480,
      paid_in_batch_id: "batch-1",
    });
    const mk0001 = aggregateDriverPayoutEligibility({
      live_balance_pence: 2239,
      entries: [mk0001Pending, mk0001Cancelled, mk0001PaidOut],
      clearing_policy: POLICY_27H,
    });
    const mk0002 = aggregateDriverPayoutEligibility({
      live_balance_pence: 773,
      entries: [
        uncleared({
          trip_status: "completed",
          ledger_entry_id: "mk2-a",
          trip_id: "t-mk2-a",
          amount_pence: 391,
          canonical_driver_net_pence: 391,
          captured_amount_pence: 450,
        }),
      ],
      clearing_policy: POLICY_27H,
    });
    expect(mk0001.pending_balance_pence).toBe(565);
    expect(mk0002.pending_balance_pence).toBe(391);
    expect(mk0001.pending_balance_pence).not.toBe(mk0002.pending_balance_pence);
    expect(evaluateLedgerEntryEligibility(mk0001Cancelled, POLICY_27H).status)
      .not.toBe(PAYOUT_ELIGIBILITY_STATUS.SETTLEMENT_PENDING);
    expect(evaluateLedgerEntryEligibility(mk0001PaidOut, POLICY_27H).status)
      .toBe(PAYOUT_ELIGIBILITY_STATUS.PAYOUT_ALLOCATED);
  });

  it("cancelled and uncaptured holds are not settlement Pending", () => {
    const capturedUncleared = [
      uncleared({ ledger_entry_id: "a", trip_id: "t1", amount_pence: 565, canonical_driver_net_pence: 565, captured_amount_pence: 650 }),
      uncleared({ ledger_entry_id: "b", trip_id: "t2", amount_pence: 396, canonical_driver_net_pence: 396, captured_amount_pence: 450 }),
      uncleared({ ledger_entry_id: "c", trip_id: "t3", amount_pence: 475, canonical_driver_net_pence: 475, captured_amount_pence: 495 }),
      uncleared({ ledger_entry_id: "d", trip_id: "t4", amount_pence: 382, canonical_driver_net_pence: 382, captured_amount_pence: 450 }),
    ];
    const noise = [
      uncleared({
        ledger_entry_id: "cancel",
        trip_id: "t-cancel",
        amount_pence: 425,
        canonical_driver_net_pence: 425,
        captured_amount_pence: null,
        payment_session_id: "ps-cancel",
      }),
      uncleared({
        ledger_entry_id: "auth",
        trip_id: "t-auth",
        amount_pence: 714,
        canonical_driver_net_pence: 714,
        captured_amount_pence: null,
        payment_session_id: "ps-auth",
      }),
    ];
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 2239,
      entries: [...capturedUncleared, ...noise],
      clearing_policy: POLICY_27H,
    });
    expect(agg.pending_balance_pence).toBe(1818);
    expect(agg.pending_balance_pence).not.toBe(2957);
    expect(agg.available_balance_pence).toBe(0);
  });

  it("MK0001: already-paid cleared history must not inflate Available above live − pending", () => {
    // Unpaid set: one cleared (£4.21) + four settlement-pending (£18.18) = £22.39 live.
    // Historical cleared rows still evaluate ELIGIBLE because DES allocation was never written.
    const unpaidCleared = cleared({
      ledger_entry_id: "mk-260813-002",
      trip_id: "t-002",
      amount_pence: 421,
      canonical_driver_net_pence: 421,
      captured_amount_pence: 495,
      captured_at: CLEARED_AT,
    });
    const unpaidPending = [
      uncleared({ ledger_entry_id: "a", trip_id: "t1", amount_pence: 565, canonical_driver_net_pence: 565, captured_amount_pence: 650 }),
      uncleared({ ledger_entry_id: "b", trip_id: "t2", amount_pence: 396, canonical_driver_net_pence: 396, captured_amount_pence: 450 }),
      uncleared({ ledger_entry_id: "c", trip_id: "t3", amount_pence: 475, canonical_driver_net_pence: 475, captured_amount_pence: 495 }),
      uncleared({ ledger_entry_id: "d", trip_id: "t4", amount_pence: 382, canonical_driver_net_pence: 382, captured_amount_pence: 450 }),
    ];
    const alreadyPaidClearedPools = [
      cleared({ ledger_entry_id: "paid-3149-a", trip_id: "tp1", amount_pence: 593, canonical_driver_net_pence: 593, captured_amount_pence: 700 }),
      cleared({ ledger_entry_id: "paid-3149-b", trip_id: "tp2", amount_pence: 408, canonical_driver_net_pence: 408, captured_amount_pence: 480 }),
      cleared({ ledger_entry_id: "paid-3149-c", trip_id: "tp3", amount_pence: 435, canonical_driver_net_pence: 435, captured_amount_pence: 510 }),
      cleared({ ledger_entry_id: "paid-3149-d", trip_id: "tp4", amount_pence: 408, canonical_driver_net_pence: 408, captured_amount_pence: 480 }),
      cleared({ ledger_entry_id: "paid-3149-e", trip_id: "tp5", amount_pence: 408, canonical_driver_net_pence: 408, captured_amount_pence: 480 }),
      cleared({ ledger_entry_id: "paid-3149-f", trip_id: "tp6", amount_pence: 897, canonical_driver_net_pence: 897, captured_amount_pence: 1050 }),
      cleared({ ledger_entry_id: "paid-3090-a", trip_id: "tp7", amount_pence: 674, canonical_driver_net_pence: 674, captured_amount_pence: 790 }),
      cleared({ ledger_entry_id: "paid-3090-b", trip_id: "tp8", amount_pence: 598, canonical_driver_net_pence: 598, captured_amount_pence: 700 }),
      cleared({ ledger_entry_id: "paid-3090-c", trip_id: "tp9", amount_pence: 297, canonical_driver_net_pence: 297, captured_amount_pence: 350 }),
      cleared({ ledger_entry_id: "paid-3090-d", trip_id: "tp10", amount_pence: 382, canonical_driver_net_pence: 382, captured_amount_pence: 450 }),
    ];
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 2239,
      entries: [unpaidCleared, ...unpaidPending, ...alreadyPaidClearedPools],
      clearing_policy: POLICY_27H,
    });
    expect(agg.live_balance_pence).toBe(2239);
    expect(agg.pending_balance_pence).toBe(1818);
    expect(agg.available_balance_pence).toBe(421);
    expect(agg.available_balance_pence + agg.pending_balance_pence).toBe(2239);
    expect(agg.eligible_earnings_pence).toBe(421);
    // Raw cleared history still evaluates ELIGIBLE, but must not inflate Available.
    expect(agg.eligible_entries.length).toBeGreaterThan(1);
  });

  it("Admin Driver Wallet list reads eligibility pending/available, not period KPI or live cashout", () => {
    const row = {
      wallet_balance_pence: 2239,
      cashout_limit_pence: 2239,
      available_for_payout_pence: 0,
      pending_balance_pence: 1818,
      period_kpis: { pending_earnings_pence: 0 },
    };
    const shown = displayDriverWalletSsotBalances(row);
    expect(shown.livePence).toBe(2239);
    expect(shown.availablePence).toBe(0);
    expect(shown.pendingPence).toBe(1818);
    expect(shown.pendingPence).not.toBe(row.period_kpis.pending_earnings_pence);
    expect(shown.availablePence).not.toBe(row.wallet_balance_pence);
  });

  it("debt recovery still wipes Available without duplicating earnings", () => {
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 2239,
      outstanding_debt_pence: 2239,
      entries: [cleared()],
      clearing_policy: POLICY_27H,
    });
    expect(agg.available_balance_pence).toBe(0);
    expect(agg.primary_hold_reason).toBe(PAYOUT_ELIGIBILITY_STATUS.DEBT_RECOVERY);
    expect(agg.eligible_entries).toHaveLength(1);
  });
});
