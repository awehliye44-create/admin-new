import { describe, expect, it } from "vitest";
import {
  FR_TRIP_AUDIT_STATUS,
  evaluateFrSettlementCaptureIdentity,
  isFrTripFullyBalanced,
  resolveFrTripAuditStatus,
} from "../../../shared/frConsumeOnlySSOT";

describe("evaluateFrSettlementCaptureIdentity", () => {
  it("never defaults BALANCED when capture missing", () => {
    expect(evaluateFrSettlementCaptureIdentity({
      captured_pence: null,
      driver_net_pence: 408,
      commission_pence: 72,
      airport_charge_pence: 0,
      tips_pence: 0,
    })).toEqual({ balanced: false, variance_pence: null, evaluable: false });

    expect(evaluateFrSettlementCaptureIdentity({
      captured_pence: 0,
      driver_net_pence: 408,
      commission_pence: 72,
      airport_charge_pence: 0,
      tips_pence: 0,
    }).balanced).toBe(false);
  });

  it("MK golden identity holds exactly", () => {
    const r = evaluateFrSettlementCaptureIdentity({
      captured_pence: 480,
      driver_net_pence: 408,
      commission_pence: 72,
      airport_charge_pence: 0,
      tips_pence: 0,
    });
    expect(r.balanced).toBe(true);
    expect(r.variance_pence).toBe(0);
  });

  it("unknown driver_net/commission is not evaluable", () => {
    expect(evaluateFrSettlementCaptureIdentity({
      captured_pence: 480,
      driver_net_pence: null,
      commission_pence: 72,
      airport_charge_pence: 0,
      tips_pence: 0,
    }).evaluable).toBe(false);
  });
});

describe("isFrTripFullyBalanced", () => {
  it("requires WALLET_MATCHED — not PENDING", () => {
    expect(isFrTripFullyBalanced({
      capture_reconciliation_status: "MATCHED",
      release_reconciliation_status: "RELEASE_NOT_REQUIRED",
      wallet_reconciliation_status: "WALLET_CREDIT_PENDING",
      settlement_identity_balanced: true,
    })).toBe(false);

    expect(isFrTripFullyBalanced({
      capture_reconciliation_status: "MATCHED",
      release_reconciliation_status: "RELEASE_NOT_REQUIRED",
      wallet_reconciliation_status: "WALLET_MATCHED",
      settlement_identity_balanced: true,
    })).toBe(true);
  });

  it("MISSING_RELEASE / UNCONFIRMED cannot be BALANCED", () => {
    expect(isFrTripFullyBalanced({
      capture_reconciliation_status: "MATCHED",
      release_reconciliation_status: "MISSING_RELEASE",
      wallet_reconciliation_status: "WALLET_MATCHED",
      settlement_identity_balanced: true,
    })).toBe(false);

    expect(isFrTripFullyBalanced({
      capture_reconciliation_status: "MATCHED",
      release_reconciliation_status: "RELEASE_AMOUNT_UNCONFIRMED",
      wallet_reconciliation_status: "WALLET_MATCHED",
      settlement_identity_balanced: true,
    })).toBe(false);
  });
});

describe("resolveFrTripAuditStatus", () => {
  it("maps capture mismatch first-class", () => {
    expect(resolveFrTripAuditStatus({
      capture_reconciliation_status: "PAYMENT_SESSION_CAPTURE_MISMATCH",
    })).toBe(FR_TRIP_AUDIT_STATUS.CAPTURE_MISMATCH);
  });

  it("maps MISSING_RELEASE and RELEASE_AMOUNT_UNCONFIRMED", () => {
    expect(resolveFrTripAuditStatus({
      capture_reconciliation_status: "MATCHED",
      release_reconciliation_status: "MISSING_RELEASE",
      wallet_reconciliation_status: "WALLET_MATCHED",
      settlement_identity_balanced: true,
    })).toBe(FR_TRIP_AUDIT_STATUS.MISSING_RELEASE);

    expect(resolveFrTripAuditStatus({
      capture_reconciliation_status: "MATCHED",
      release_reconciliation_status: "RELEASE_AMOUNT_UNCONFIRMED",
      wallet_reconciliation_status: "WALLET_MATCHED",
      settlement_identity_balanced: true,
    })).toBe(FR_TRIP_AUDIT_STATUS.RELEASE_AMOUNT_UNCONFIRMED);
  });

  it("never defaults BALANCED", () => {
    expect(resolveFrTripAuditStatus({})).toBe(FR_TRIP_AUDIT_STATUS.PENDING_SYNC);
  });
});
