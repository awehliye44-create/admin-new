import { describe, expect, it } from "vitest";
import {
  PAYOUT_ELIGIBILITY_STATUS,
  aggregateDriverPayoutEligibility,
  type LedgerEligibilityEvidence,
} from "../../../shared/driverPayoutEligibilitySSOT";
import {
  DRIVER_PAYOUT_BLOCK_REASON,
  DRIVER_PAYOUT_WITHDRAWAL_QUOTE_VERSION,
  assertClientAmountWithinWithdrawable,
  blockingReasonCopy,
  buildDriverPayoutWithdrawalQuote,
} from "../../../shared/driverPayoutWithdrawalQuoteSSOT";

function revolutTripCredit(overrides: Partial<LedgerEligibilityEvidence> = {}): LedgerEligibilityEvidence {
  return {
    ledger_entry_id: "8f327a10-6517-4c36-82ef-124862a5cb56",
    trip_id: "trip-mk-007",
    ledger_type: "TRIP_EARNING_NET",
    amount_pence: 408,
    trip_exists: true,
    payment_session_id: "977de67e-ps",
    captured_amount_pence: 480,
    canonical_driver_net_pence: 408,
    fr_trip_status: "BALANCED",
    refunded_amount_pence: 0,
    des_present: false,
    captured_at: "2020-01-01T00:00:00.000Z",
    earning_credited_at: "2020-01-01T00:00:00.000Z",
    provider_available_on: "2020-01-01T00:00:00.000Z",
    payment_collection_model: "PLATFORM_COLLECTED",
    financial_model: "PLATFORM_COLLECTED",
    ...overrides,
  };
}

function mk0006Eligibility() {
  const entries: LedgerEligibilityEvidence[] = [
    revolutTripCredit({ ledger_entry_id: "a", trip_id: "t1", amount_pence: 425, canonical_driver_net_pence: 425, captured_amount_pence: 500 }),
    revolutTripCredit({ ledger_entry_id: "b", trip_id: "t2", amount_pence: 595, canonical_driver_net_pence: 595, captured_amount_pence: 700 }),
    revolutTripCredit({ ledger_entry_id: "c", trip_id: "t3", amount_pence: 425, canonical_driver_net_pence: 425, captured_amount_pence: 500 }),
    revolutTripCredit({ ledger_entry_id: "d", trip_id: "t4", amount_pence: 425, canonical_driver_net_pence: 425, captured_amount_pence: 500 }),
    revolutTripCredit({
      ledger_entry_id: "e",
      trip_id: "t5",
      ledger_type: "DRIVER_TIP_CREDIT",
      amount_pence: 100,
      canonical_tip_pence: 100,
      canonical_driver_net_pence: null,
      captured_amount_pence: 100,
    }),
    revolutTripCredit({ ledger_entry_id: "f", trip_id: "t6", amount_pence: 924, canonical_driver_net_pence: 924, captured_amount_pence: 1100 }),
    revolutTripCredit({ ledger_entry_id: "g", trip_id: "t7", amount_pence: 425, canonical_driver_net_pence: 425, captured_amount_pence: 500 }),
  ];
  return aggregateDriverPayoutEligibility({
    live_balance_pence: 3319,
    outstanding_debt_pence: 0,
    payout_operational_paused: false,
    payouts_enabled: false, // legacy — must NOT override Stage C
    account_verified: true,
    payout_provider_available: true,
    entries,
  });
}

describe("driverPayoutWithdrawalQuoteSSOT — Stage C2 cutover", () => {
  it("1. MK0006: legacy payouts_enabled=false does not override Stage C — withdrawable 3319", () => {
    const eligibility = mk0006Eligibility();
    expect(eligibility.available_balance_pence).toBe(3319);
    expect(eligibility.primary_hold_reason).toBeNull();

    const quote = buildDriverPayoutWithdrawalQuote({
      eligibility,
      global_payouts_enabled: true,
      payout_operational_paused: false,
      provider_verified_active_destination: true,
      driver_approved: true,
      driver_suspended: false,
      fee_pence: 50,
      minimum_pence: 51,
      early_cash_out_enabled: true,
      provider_available: true,
      financial_model_platform_collected: true,
      legacy_payouts_enabled: false,
    });

    expect(quote.ledger_balance_pence).toBe(3319);
    expect(quote.cleared_available_pence).toBe(3319);
    expect(quote.pending_pence).toBe(0);
    expect(quote.withdrawable_pence).toBe(3319);
    expect(quote.requested_pence).toBe(3319);
    expect(quote.fee_pence).toBe(50);
    expect(quote.net_payout_pence).toBe(3269);
    expect(quote.payout_allowed).toBe(true);
    expect(quote.blocking_reason_code).toBeNull();
    expect(quote.eligibility_version).toBe(DRIVER_PAYOUT_WITHDRAWAL_QUOTE_VERSION);
    expect(quote.legacy_payouts_enabled).toBe(false);
  });

  it("2. Global payouts disabled → FEATURE_DISABLED", () => {
    const quote = buildDriverPayoutWithdrawalQuote({
      eligibility: mk0006Eligibility(),
      global_payouts_enabled: false,
      payout_operational_paused: false,
      provider_verified_active_destination: true,
      driver_approved: true,
      driver_suspended: false,
      fee_pence: 50,
      early_cash_out_enabled: true,
    });
    expect(quote.payout_allowed).toBe(false);
    expect(quote.withdrawable_pence).toBe(0);
    expect(quote.blocking_reason_code).toBe(DRIVER_PAYOUT_BLOCK_REASON.FEATURE_DISABLED);
    expect(quote.blocking_reason_copy).toBe(blockingReasonCopy(DRIVER_PAYOUT_BLOCK_REASON.FEATURE_DISABLED));
  });

  it("3. Operational pause → ADMIN_HOLD typed copy (not NO_AVAILABLE_BALANCE)", () => {
    const eligibility = aggregateDriverPayoutEligibility({
      live_balance_pence: 3319,
      payout_operational_paused: true,
      payouts_enabled: true,
      entries: [revolutTripCredit({ amount_pence: 3319, canonical_driver_net_pence: 3319, captured_amount_pence: 4000 })],
    });
    expect(eligibility.available_balance_pence).toBe(0);
    expect(eligibility.primary_hold_reason).toBe(PAYOUT_ELIGIBILITY_STATUS.ADMIN_HOLD);

    const quote = buildDriverPayoutWithdrawalQuote({
      eligibility,
      global_payouts_enabled: true,
      payout_operational_paused: true,
      provider_verified_active_destination: true,
      driver_approved: true,
      driver_suspended: false,
      fee_pence: 50,
      early_cash_out_enabled: true,
    });
    expect(quote.blocking_reason_code).toBe(DRIVER_PAYOUT_BLOCK_REASON.ADMIN_HOLD);
    expect(quote.blocking_reason_code).not.toBe(DRIVER_PAYOUT_BLOCK_REASON.NO_AVAILABLE_BALANCE);
    expect(quote.blocking_reason_copy).toMatch(/paused/i);
  });

  it("4. Unverified payout account → verification block; Available stays cleared", () => {
    const eligibility = aggregateDriverPayoutEligibility({
      live_balance_pence: 3319,
      payout_operational_paused: false,
      account_verified: false,
      entries: [revolutTripCredit({ amount_pence: 3319, canonical_driver_net_pence: 3319, captured_amount_pence: 4000 })],
    });
    expect(eligibility.available_balance_pence).toBe(3319);

    const quote = buildDriverPayoutWithdrawalQuote({
      eligibility,
      global_payouts_enabled: true,
      payout_operational_paused: false,
      provider_verified_active_destination: false,
      driver_approved: true,
      driver_suspended: false,
      fee_pence: 50,
      early_cash_out_enabled: true,
    });
    expect(quote.cleared_available_pence).toBe(3319);
    expect(quote.withdrawable_pence).toBe(0);
    expect(quote.blocking_reason_code).toBe(DRIVER_PAYOUT_BLOCK_REASON.PAYOUT_ACCOUNT_NOT_VERIFIED);
  });

  it("5. Pending/uncleared only → FUNDS_CLEARING", () => {
    const eligibility = aggregateDriverPayoutEligibility({
      live_balance_pence: 408,
      payout_operational_paused: false,
      account_verified: true,
      clearing_policy: {
        clearing_delay_hours: 27,
        now_ms: Date.parse("2020-01-01T01:00:00.000Z"),
      },
      entries: [
        revolutTripCredit({
          amount_pence: 408,
          canonical_driver_net_pence: 408,
          captured_at: "2020-01-01T00:00:00.000Z",
          earning_credited_at: "2020-01-01T00:00:00.000Z",
          provider_available_on: null,
          provider_state: "CAPTURED",
        }),
      ],
    });
    expect(eligibility.available_balance_pence).toBe(0);
    expect(eligibility.pending_balance_pence).toBeGreaterThan(0);

    const quote = buildDriverPayoutWithdrawalQuote({
      eligibility,
      global_payouts_enabled: true,
      payout_operational_paused: false,
      provider_verified_active_destination: true,
      driver_approved: true,
      driver_suspended: false,
      fee_pence: 50,
      early_cash_out_enabled: true,
    });
    expect(quote.blocking_reason_code).toBe(DRIVER_PAYOUT_BLOCK_REASON.FUNDS_CLEARING);
  });

  it("14. Genuine zero balance → NO_AVAILABLE_BALANCE", () => {
    const eligibility = aggregateDriverPayoutEligibility({
      live_balance_pence: 0,
      entries: [],
    });
    const quote = buildDriverPayoutWithdrawalQuote({
      eligibility,
      global_payouts_enabled: true,
      payout_operational_paused: false,
      provider_verified_active_destination: true,
      driver_approved: true,
      driver_suspended: false,
      fee_pence: 50,
      early_cash_out_enabled: true,
    });
    expect(quote.blocking_reason_code).toBe(DRIVER_PAYOUT_BLOCK_REASON.NO_AVAILABLE_BALANCE);
  });

  it("11/12. Client amount above withdrawable / stale quote rejected", () => {
    const quote = buildDriverPayoutWithdrawalQuote({
      eligibility: mk0006Eligibility(),
      global_payouts_enabled: true,
      payout_operational_paused: false,
      provider_verified_active_destination: true,
      driver_approved: true,
      driver_suspended: false,
      fee_pence: 50,
      minimum_pence: 51,
      early_cash_out_enabled: true,
    });
    const over = assertClientAmountWithinWithdrawable({
      client_requested_pence: 4000,
      quote,
    });
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.code).toBe(DRIVER_PAYOUT_BLOCK_REASON.AMOUNT_EXCEEDS_WITHDRAWABLE);
    }
    const stale = assertClientAmountWithinWithdrawable({
      client_requested_pence: 3000,
      quote,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.code).toBe(DRIVER_PAYOUT_BLOCK_REASON.STALE_QUOTE);
    }
    const ok = assertClientAmountWithinWithdrawable({
      client_requested_pence: 3319,
      quote,
    });
    expect(ok.ok).toBe(true);
  });

  it("16. Gross 3319 fee 50 → net 3269", () => {
    const quote = buildDriverPayoutWithdrawalQuote({
      eligibility: mk0006Eligibility(),
      global_payouts_enabled: true,
      payout_operational_paused: false,
      provider_verified_active_destination: true,
      driver_approved: true,
      driver_suspended: false,
      fee_pence: 50,
      early_cash_out_enabled: true,
    });
    expect(quote.net_payout_pence).toBe(3269);
  });

  it("8. DRIVER_COLLECTED model blocked", () => {
    const quote = buildDriverPayoutWithdrawalQuote({
      eligibility: mk0006Eligibility(),
      global_payouts_enabled: true,
      payout_operational_paused: false,
      provider_verified_active_destination: true,
      driver_approved: true,
      driver_suspended: false,
      fee_pence: 50,
      early_cash_out_enabled: true,
      financial_model_platform_collected: false,
    });
    expect(quote.blocking_reason_code).toBe(DRIVER_PAYOUT_BLOCK_REASON.DRIVER_COLLECTED_MODEL);
  });

  it("9. Inactive/unapproved driver blocked", () => {
    const quote = buildDriverPayoutWithdrawalQuote({
      eligibility: mk0006Eligibility(),
      global_payouts_enabled: true,
      payout_operational_paused: false,
      provider_verified_active_destination: true,
      driver_approved: false,
      driver_suspended: false,
      fee_pence: 50,
      early_cash_out_enabled: true,
    });
    expect(quote.blocking_reason_code).toBe(DRIVER_PAYOUT_BLOCK_REASON.DRIVER_NOT_APPROVED);
  });

  it("7. Reserved/in-flight excluded from withdrawable", () => {
    const eligibility = aggregateDriverPayoutEligibility({
      live_balance_pence: 3319,
      reserved_payout_pence: 1000,
      payout_operational_paused: false,
      account_verified: true,
      entries: [revolutTripCredit({ amount_pence: 3319, canonical_driver_net_pence: 3319, captured_amount_pence: 4000 })],
    });
    expect(eligibility.available_balance_pence).toBe(2319);
    const quote = buildDriverPayoutWithdrawalQuote({
      eligibility,
      global_payouts_enabled: true,
      payout_operational_paused: false,
      provider_verified_active_destination: true,
      driver_approved: true,
      driver_suspended: false,
      fee_pence: 50,
      early_cash_out_enabled: true,
    });
    expect(quote.reserved_pence).toBe(1000);
    expect(quote.withdrawable_pence).toBe(2319);
  });
});
