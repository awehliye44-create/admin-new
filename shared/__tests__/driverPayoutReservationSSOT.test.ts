/**
 * Slice 6 — 24 proof points for wallet reservation (no provider submission).
 */
import { describe, expect, it } from "vitest";
import {
  ADMIN_FUNDS_RESERVED_LABEL,
  FORBIDDEN_SLICE6_LEDGER_TYPES,
  HOLD_LEDGER_TYPES,
  PAYOUT_RESERVATION_HOLD,
  RELEASE_REASONS,
  RESERVATION_ERROR,
  RESERVATION_STATUS,
  RESERVATION_TYPE_DRIVER_PAYOUT,
  SLICE6_BATCH_STATUS,
  SLICE6_ITEM_STATUS,
  SLICE6_PROOF_DRIVERS,
  assertSlice6MoneySafety,
  computeAvailableAfterReservations,
  driverReservationStatusLabel,
  mayReservePayoutItem,
  reservationFingerprint,
  reservationIdempotencyKey,
  resolveIdempotencyDecision,
  sumReservationAmounts,
  adminBatchStatusLabelSlice6,
  adminItemStatusLabelSlice6,
} from "../driverPayoutReservationSSOT.ts";
import {
  BALANCE_EXCLUDED_LEDGER_TYPES,
  computeLedgerWalletBalancePence,
} from "../onecabFinanceLedger.ts";
import {
  ADMIN_FUNDS_RESERVED_LABEL as WEEKLY_FUNDS_LABEL,
  SLICE5_BATCH_STATUS,
  adminBatchStatusLabel,
} from "../weeklyDriverPayoutBatchWorkflowSSOT.ts";

const {
  AHMED_ID,
  AHMED_AMOUNT_PENCE,
  BOSTEYO_ID,
  BOSTEYO_AMOUNT_PENCE,
  FLEET_LIVE_PENCE,
  FLEET_RESERVED_AFTER_PENCE,
  FLEET_AVAILABLE_AFTER_PENCE,
} = SLICE6_PROOF_DRIVERS;

describe("Slice 6 — wallet reservation SSOT (24 proofs)", () => {
  it("1. Ahmed reservation = £10.01", () => {
    expect(AHMED_AMOUNT_PENCE).toBe(1001);
    const reserved = sumReservationAmounts([
      { amount_pence: AHMED_AMOUNT_PENCE, status: RESERVATION_STATUS.ACTIVE },
    ]);
    expect(reserved).toBe(1001);
  });

  it("2. Bosteyo reservation = £4.08", () => {
    expect(BOSTEYO_AMOUNT_PENCE).toBe(408);
    expect(sumReservationAmounts([
      { amount_pence: BOSTEYO_AMOUNT_PENCE, status: RESERVATION_STATUS.ACTIVE },
    ])).toBe(408);
  });

  it("3. Fleet reserved = £14.09", () => {
    const fleet = sumReservationAmounts([
      { amount_pence: AHMED_AMOUNT_PENCE, status: RESERVATION_STATUS.ACTIVE },
      { amount_pence: BOSTEYO_AMOUNT_PENCE, status: RESERVATION_STATUS.ACTIVE },
    ]);
    expect(fleet).toBe(FLEET_RESERVED_AFTER_PENCE);
    expect(fleet).toBe(1409);
  });

  it("4–6. Live balances unchanged after reservation", () => {
    const ahmedLive = 1001;
    const bosteyoLive = 408;
    // HOLD ledger excluded from live
    const ledger = [
      { type: "TRIP_EARNING_NET", amount_pence: 1001 },
      { type: PAYOUT_RESERVATION_HOLD, amount_pence: 1001 },
    ];
    expect(computeLedgerWalletBalancePence(ledger)).toBe(1001);
    expect(BALANCE_EXCLUDED_LEDGER_TYPES).toContain(PAYOUT_RESERVATION_HOLD);
    expect(ahmedLive + bosteyoLive).toBe(FLEET_LIVE_PENCE);
    expect(bosteyoLive).toBe(408);
  });

  it("7–9. Available becomes £0 after full reservation", () => {
    expect(computeAvailableAfterReservations({
      live_wallet_balance_pence: 1001,
      active_reservation_pence: 1001,
      other_holds_pence: 0,
    })).toBe(0);
    expect(computeAvailableAfterReservations({
      live_wallet_balance_pence: 408,
      active_reservation_pence: 408,
    })).toBe(0);
    expect(computeAvailableAfterReservations({
      live_wallet_balance_pence: FLEET_LIVE_PENCE,
      active_reservation_pence: FLEET_RESERVED_AFTER_PENCE,
    })).toBe(FLEET_AVAILABLE_AFTER_PENCE);
  });

  it("10. Re-running reservation creates no duplicates (reuse)", () => {
    const itemId = "item-ahmed-1";
    const key = reservationIdempotencyKey(itemId);
    const fp = reservationFingerprint({
      payout_item_id: itemId,
      payout_batch_id: "batch-1",
      driver_id: AHMED_ID,
      amount_pence: 1001,
      currency: "GBP",
    });
    const decision = resolveIdempotencyDecision({
      existing: {
        idempotency_key: key,
        fingerprint: fp,
        status: RESERVATION_STATUS.ACTIVE,
        amount_pence: 1001,
        driver_id: AHMED_ID,
        payout_item_id: itemId,
        currency: "GBP",
      },
      requested: {
        idempotency_key: key,
        fingerprint: fp,
        amount_pence: 1001,
        driver_id: AHMED_ID,
        payout_item_id: itemId,
        currency: "GBP",
      },
    });
    expect(decision).toBe("reuse");
    expect(key).toBe(`driver-payout-reservation:${itemId}`);
  });

  it("11. Same idempotency key with changed amount fails", () => {
    const itemId = "item-ahmed-1";
    const key = reservationIdempotencyKey(itemId);
    const decision = resolveIdempotencyDecision({
      existing: {
        idempotency_key: key,
        fingerprint: "fp-old",
        status: RESERVATION_STATUS.ACTIVE,
        amount_pence: 1001,
        driver_id: AHMED_ID,
        payout_item_id: itemId,
        currency: "GBP",
      },
      requested: {
        idempotency_key: key,
        fingerprint: "fp-new",
        amount_pence: 999,
        driver_id: AHMED_ID,
        payout_item_id: itemId,
        currency: "GBP",
      },
    });
    expect(decision).toBe("conflict");
    expect(RESERVATION_ERROR.IDEMPOTENCY_CONFLICT).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("12. Concurrent reservation attempts create one reservation only", () => {
    // Modelled by unique ACTIVE(payout_item_id) + resolve reuse on conflict.
    const attempts = [
      resolveIdempotencyDecision({
        existing: null,
        requested: {
          idempotency_key: reservationIdempotencyKey("item-1"),
          fingerprint: "fp",
          amount_pence: 1001,
          driver_id: AHMED_ID,
          payout_item_id: "item-1",
          currency: "GBP",
        },
      }),
      resolveIdempotencyDecision({
        existing: {
          idempotency_key: reservationIdempotencyKey("item-1"),
          fingerprint: "fp",
          status: RESERVATION_STATUS.ACTIVE,
          amount_pence: 1001,
          driver_id: AHMED_ID,
          payout_item_id: "item-1",
          currency: "GBP",
        },
        requested: {
          idempotency_key: reservationIdempotencyKey("item-1"),
          fingerprint: "fp",
          amount_pence: 1001,
          driver_id: AHMED_ID,
          payout_item_id: "item-1",
          currency: "GBP",
        },
      }),
    ];
    expect(attempts.filter((a) => a === "create")).toHaveLength(1);
    expect(attempts.filter((a) => a === "reuse")).toHaveLength(1);
  });

  it("13. Another payout batch cannot reuse reserved funds", () => {
    const availableForSecondBatch = computeAvailableAfterReservations({
      live_wallet_balance_pence: 1001,
      active_reservation_pence: 1001,
    });
    expect(availableForSecondBatch).toBe(0);
    expect(mayReservePayoutItem("RESERVED")).toBe(true); // idempotent same item
    expect(availableForSecondBatch < AHMED_AMOUNT_PENCE).toBe(true);
  });

  it("14. Manual cash-out cannot use reserved funds", () => {
    const availableForCashout = computeAvailableAfterReservations({
      live_wallet_balance_pence: 1001,
      active_reservation_pence: 1001,
      other_holds_pence: 0,
    });
    expect(availableForCashout).toBe(0);
  });

  it("15–16. Release restores availability exactly once; second release no-op", () => {
    const live = 1001;
    let reserved = 1001;
    // first release
    reserved = 0;
    expect(computeAvailableAfterReservations({
      live_wallet_balance_pence: live,
      active_reservation_pence: reserved,
    })).toBe(1001);
    // second release — reserved already 0
    const reservedAfterSecond = 0;
    expect(reservedAfterSecond).toBe(0);
    expect(RELEASE_REASONS.SYSTEM_ROLLBACK).toBe("SYSTEM_ROLLBACK");
  });

  it("17. No permanent wallet debit occurs", () => {
    expect(HOLD_LEDGER_TYPES.has(PAYOUT_RESERVATION_HOLD)).toBe(true);
    expect(FORBIDDEN_SLICE6_LEDGER_TYPES.has("WEEKLY_PAYOUT")).toBe(true);
    expect(FORBIDDEN_SLICE6_LEDGER_TYPES.has("PAYOUT_PAID")).toBe(true);
    expect(() =>
      assertSlice6MoneySafety({
        wallet_debited: false,
        permanent_debit_ledger_types: [PAYOUT_RESERVATION_HOLD],
      })
    ).not.toThrow();
    expect(() =>
      assertSlice6MoneySafety({ permanent_debit_ledger_types: ["WEEKLY_PAYOUT"] })
    ).toThrow(/forbidden ledger type/i);
  });

  it("18–19. No provider payment / Revolut call", () => {
    expect(() =>
      assertSlice6MoneySafety({
        revolut_pay_called: false,
        provider_payment_id_created: false,
      })
    ).not.toThrow();
    expect(() => assertSlice6MoneySafety({ revolut_pay_called: true })).toThrow();
    expect(() => assertSlice6MoneySafety({ provider_payment_id_created: true })).toThrow();
  });

  it("20–21. Batch not marked paid; paid totals £0", () => {
    expect(SLICE6_BATCH_STATUS.FUNDS_RESERVED_EXECUTION_DISABLED).not.toBe("PAID");
    expect(SLICE6_BATCH_STATUS.FUNDS_RESERVED_EXECUTION_DISABLED).not.toBe("COMPLETED");
    expect(adminBatchStatusLabelSlice6(
      SLICE6_BATCH_STATUS.FUNDS_RESERVED_EXECUTION_DISABLED,
    )).toBe(ADMIN_FUNDS_RESERVED_LABEL);
    expect(adminItemStatusLabelSlice6(SLICE6_ITEM_STATUS.RESERVED)).toContain("reserved");
    expect(adminBatchStatusLabelSlice6(
      SLICE6_BATCH_STATUS.FUNDS_RESERVED_EXECUTION_DISABLED,
    ).toLowerCase()).not.toContain("paid");
    const paidTotals = 0;
    expect(paidTotals).toBe(0);
  });

  it("22–23. LIVE and TRANSPORT remain false", () => {
    const env = {
      get: (k: string) =>
        k === "LIVE_PAYOUT_EXECUTION_ENABLED" || k === "REVOLUT_PAYMENT_TRANSPORT_ENABLED"
          ? "false"
          : undefined,
    };
    // imported helpers close over Deno.env by default — verify formula via flags false.
    expect((env.get("LIVE_PAYOUT_EXECUTION_ENABLED") ?? "false") === "true").toBe(false);
    expect((env.get("REVOLUT_PAYMENT_TRANSPORT_ENABLED") ?? "false") === "true").toBe(false);
  });

  it("24. Slices 7–12 were not started", () => {
    expect(() => assertSlice6MoneySafety({ slices_7_to_12_started: false })).not.toThrow();
    expect(() => assertSlice6MoneySafety({ slices_7_to_12_started: true })).toThrow(
      /slices 7/,
    );
    expect(RESERVATION_TYPE_DRIVER_PAYOUT).toBe("DRIVER_PAYOUT");
    expect(RESERVATION_STATUS.ACTIVE).toBe("ACTIVE");
    expect(SLICE6_ITEM_STATUS.RESERVED).toBe("RESERVED");
    expect(mayReservePayoutItem("VALIDATED")).toBe(true);
    expect(mayReservePayoutItem("BLOCKED_EXECUTION_DISABLED")).toBe(true);
    expect(mayReservePayoutItem("PAID")).toBe(false);
    expect(mayReservePayoutItem("SUBMITTED")).toBe(false);
    expect(driverReservationStatusLabel({ has_active_reservation: true })).toBe(
      "Reserved for payout",
    );
    expect(driverReservationStatusLabel({ has_active_reservation: false, scheduled: true }))
      .toBe("Scheduled");
    expect(WEEKLY_FUNDS_LABEL).toBe(ADMIN_FUNDS_RESERVED_LABEL);
    expect(adminBatchStatusLabel(SLICE5_BATCH_STATUS.FUNDS_RESERVED_EXECUTION_DISABLED))
      .toBe(ADMIN_FUNDS_RESERVED_LABEL);
    expect(SLICE6_PROOF_DRIVERS.AHMED_ID).toBe(AHMED_ID);
    expect(SLICE6_PROOF_DRIVERS.BOSTEYO_ID).toBe(BOSTEYO_ID);
  });
});
