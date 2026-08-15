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
const POLICY_48H = { now_ms: NOW_MS, clearing_delay_hours: 48 };

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
    const r = evaluateLedgerEntryEligibility(uncleared(), POLICY_48H);
    expect(r.status).toBe(PAYOUT_ELIGIBILITY_STATUS.SETTLEMENT_PENDING);
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 2239,
      entries: [uncleared()],
      clearing_policy: POLICY_48H,
    });
    expect(agg).toMatchObject({
      live_balance_pence: 2239,
      pending_balance_pence: 2239,
      available_balance_pence: 0,
    });
  });

  it("2. payout-cleared → Available", () => {
    const r = evaluateLedgerEntryEligibility(cleared(), POLICY_48H);
    expect(r.status).toBe(PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE);
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 2239,
      entries: [cleared()],
      clearing_policy: POLICY_48H,
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
      },
    ];
    const pendingAgg = aggregateDriverPayoutEligibility({
      live_balance_pence: 2239,
      entries: [uncleared()],
      clearing_policy: POLICY_48H,
    });
    const availableAgg = aggregateDriverPayoutEligibility({
      live_balance_pence: 2239,
      entries: [cleared()],
      clearing_policy: POLICY_48H,
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
      clearing_policy: POLICY_48H,
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
      clearing_policy: POLICY_48H,
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
      clearing_policy: POLICY_48H,
    });
    expect(agg.pending_balance_pence).toBe(2239);
    expect(agg.withdrawal_in_progress_pence).toBe(500);
    expect(agg.available_balance_pence).toBe(0);
  });

  it("10. refund before availability holds the earning", () => {
    const r = evaluateLedgerEntryEligibility(
      uncleared({ refunded_amount_pence: 2634 }),
      POLICY_48H,
    );
    expect(r.status).toBe(PAYOUT_ELIGIBILITY_STATUS.REFUND_HOLD);
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 0,
      entries: [uncleared({ refunded_amount_pence: 2634 })],
      clearing_policy: POLICY_48H,
    });
    expect(agg.available_balance_pence).toBe(0);
    expect(agg.pending_balance_pence).toBe(0);
  });

  it("11. refund after availability holds the earning", () => {
    const r = evaluateLedgerEntryEligibility(
      cleared({ refunded_amount_pence: 2634 }),
      POLICY_48H,
    );
    expect(r.status).toBe(PAYOUT_ELIGIBILITY_STATUS.REFUND_HOLD);
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 0,
      entries: [cleared({ refunded_amount_pence: 2634 })],
      clearing_policy: POLICY_48H,
    });
    expect(agg.available_balance_pence).toBe(0);
  });

  it("12. chargeback is held and not Available", () => {
    const r = evaluateLedgerEntryEligibility(
      uncleared({ chargeback_hold: true }),
      POLICY_48H,
    );
    expect(r.status).toBe(PAYOUT_ELIGIBILITY_STATUS.CHARGEBACK_HOLD);
  });

  it("13. partial capture is CAPTURE_MISMATCH, not Available", () => {
    const r = evaluateLedgerEntryEligibility(
      uncleared({ captured_amount_pence: 1000, canonical_driver_net_pence: 2239 }),
      POLICY_48H,
    );
    expect(r.status).toBe(PAYOUT_ELIGIBILITY_STATUS.CAPTURE_MISMATCH);
  });

  it("14. incremental-auth / capture failure stays CAPTURE_PENDING", () => {
    const authorisedOnly = evaluateLedgerEntryEligibility(
      uncleared({
        captured_amount_pence: null,
        payment_session_id: "ps-auth",
      }),
      POLICY_48H,
    );
    expect(authorisedOnly.status).toBe(PAYOUT_ELIGIBILITY_STATUS.CAPTURE_PENDING);
    const captureFail = evaluateLedgerEntryEligibility(
      uncleared({ captured_amount_pence: 0 }),
      POLICY_48H,
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
      clearing_policy: POLICY_48H,
    });
    expect(agg.available_balance_pence).toBe(0);
    expect(agg.pending_balance_pence).toBe(773);
    expect(agg.live_balance_pence).toBe(773);
    expect(agg.eligible_entries).toHaveLength(0);
  });

  it("16. payout consumes Available exactly once", () => {
    const first = evaluateLedgerEntryEligibility(
      cleared({ allocated_to_payout: true }),
      POLICY_48H,
    );
    expect(first.status).toBe(PAYOUT_ELIGIBILITY_STATUS.PAYOUT_ALLOCATED);
    expect(first.payable_pence).toBe(0);
    const agg = aggregateDriverPayoutEligibility({
      live_balance_pence: 0,
      entries: [cleared({ allocated_to_payout: true })],
      clearing_policy: POLICY_48H,
    });
    expect(agg.available_balance_pence).toBe(0);
    expect(agg.eligible_entries).toHaveLength(0);
  });

  it("DRIVER_COLLECTED_COMMISSION_WALLET is not settlement-pending after capture", () => {
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
      POLICY_48H,
    );
    expect(r.status).toBe(PAYOUT_ELIGIBILITY_STATUS.ELIGIBLE);
  });

  it("capture timestamp alone is not sufficient; delay fallback is backend-owned", () => {
    expect(isPayoutClearedForPlatformCollected({
      payment_collection_model: "PLATFORM_COLLECTED",
      captured_at: FRESH_CAPTURE,
    }, POLICY_48H)).toBe(false);
    expect(isPayoutClearedForPlatformCollected({
      payment_collection_model: "PLATFORM_COLLECTED",
      captured_at: "2026-08-13T12:00:00.000Z",
    }, POLICY_48H)).toBe(true);
    expect(isPayoutClearedForPlatformCollected({
      payment_collection_model: "PLATFORM_COLLECTED",
      provider_state: "COMPLETED",
      captured_at: FRESH_CAPTURE,
    }, POLICY_48H)).toBe(false);
    expect(isPayoutClearedForPlatformCollected({
      payment_collection_model: "PLATFORM_COLLECTED",
      provider_available_on: CLEARED_AT,
    }, POLICY_48H)).toBe(true);
  });

  it("DES settlement_status=settled is capture companion, not merchant clearing", () => {
    const r = evaluateLedgerEntryEligibility(
      uncleared({
        des_present: true,
        des_settlement_status: "settled",
        settled_at: FRESH_CAPTURE,
      }),
      POLICY_48H,
    );
    expect(r.status).toBe(PAYOUT_ELIGIBILITY_STATUS.SETTLEMENT_PENDING);
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
      clearing_policy: POLICY_48H,
    });
    expect(agg.available_balance_pence).toBe(0);
    expect(agg.primary_hold_reason).toBe(PAYOUT_ELIGIBILITY_STATUS.DEBT_RECOVERY);
    expect(agg.eligible_entries).toHaveLength(1);
  });
});
