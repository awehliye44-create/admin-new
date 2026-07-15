import { describe, expect, it } from "vitest";
import {
  buildCompanyTransferFundingSnapshot,
  canTransitionCompanyTransferStatus,
  COMPANY_TRANSFER_GATE_REASON,
  evaluateCompanyTransferExecutionGate,
  evaluateCompanyTransferFundingGate,
  parseLiveCompanyTransferExecutionEnabled,
  SLICE11_PROOF,
  assertCompanyTransferSelfApprovalPolicy,
} from "../companyTransferLifecycleSSOT";

function unavailableSnapshot() {
  return buildCompanyTransferFundingSnapshot({
    capture_phase: "APPROVAL",
    service_area_id: SLICE11_PROOF.SERVICE_AREA_ID_MK,
    currency: "GBP",
    source_balance_pence: SLICE11_PROOF.SOURCE_PENCE,
    protected_liabilities_pence: SLICE11_PROOF.LIABILITY_PENCE,
    reserved_driver_payouts_pence: SLICE11_PROOF.RESERVED_PENCE,
    approved_payables_pence: 0,
    classified_company_cash_pence: SLICE11_PROOF.NET_COMMISSION_PENCE,
    eligible_company_cash_pence: SLICE11_PROOF.BEFORE_RESERVE_PENCE,
    transferable_base_pence: SLICE11_PROOF.NET_COMMISSION_PENCE,
    operational_reserve_pence: null,
    operational_reserve_status: "NOT_CONFIGURED",
    operational_reserve_reason_code: "OPERATIONAL_RESERVE_NOT_CONFIGURED",
    final_company_available_pence: null,
  });
}

describe("companyTransferLifecycleSSOT Slice 11", () => {
  it("defaults LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED to false", () => {
    expect(parseLiveCompanyTransferExecutionEnabled(() => undefined)).toBe(false);
    expect(parseLiveCompanyTransferExecutionEnabled((k) =>
      k === "LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED" ? "false" : undefined
    )).toBe(false);
    expect(parseLiveCompanyTransferExecutionEnabled((k) =>
      k === "LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED" ? "true" : undefined
    )).toBe(true);
  });

  it("blocks approval when reserve not configured — required proof codes", () => {
    const snap = unavailableSnapshot();
    expect(snap.unclassified_company_cash_pence).toBe(SLICE11_PROOF.UNCLASSIFIED_PENCE);
    const gate = evaluateCompanyTransferFundingGate({
      amount_pence: 100,
      funding_snapshot: snap,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason_codes).toContain(
      COMPANY_TRANSFER_GATE_REASON.OPERATIONAL_RESERVE_NOT_CONFIGURED,
    );
    expect(gate.reason_codes).toContain(
      COMPANY_TRANSFER_GATE_REASON.FINAL_COMPANY_FUNDS_UNAVAILABLE,
    );
    expect(gate.reason_codes).toContain(
      COMPANY_TRANSFER_GATE_REASON.UNCLASSIFIED_COMPANY_CASH_PRESENT,
    );
  });

  it("allows gate when final authoritative even if unclassified residue exists unused", () => {
    const snap = buildCompanyTransferFundingSnapshot({
      capture_phase: "APPROVAL",
      source_balance_pence: 10_000,
      protected_liabilities_pence: 1000,
      approved_payables_pence: 0,
      classified_company_cash_pence: 5000,
      eligible_company_cash_pence: 9000,
      transferable_base_pence: 5000,
      operational_reserve_pence: 500,
      operational_reserve_status: "ACTIVE",
      final_company_available_pence: 4500,
    });
    expect(snap.final_available_authoritative).toBe(true);
    expect(snap.unclassified_company_cash_pence).toBe(4000);
    const ok = evaluateCompanyTransferFundingGate({
      amount_pence: 100,
      funding_snapshot: snap,
    });
    expect(ok.allowed).toBe(true);
    expect(ok.reason_codes).not.toContain(
      COMPANY_TRANSFER_GATE_REASON.UNCLASSIFIED_COMPANY_CASH_PRESENT,
    );
    const tooBig = evaluateCompanyTransferFundingGate({
      amount_pence: 5000,
      funding_snapshot: snap,
    });
    expect(tooBig.allowed).toBe(false);
    expect(tooBig.reason_codes).toContain(
      COMPANY_TRANSFER_GATE_REASON.INSUFFICIENT_FINAL_AVAILABLE,
    );
  });

  it("execution gate always includes live-disabled when flag false", () => {
    const snap = buildCompanyTransferFundingSnapshot({
      capture_phase: "PRE_EXECUTION",
      classified_company_cash_pence: 5000,
      eligible_company_cash_pence: 5000,
      operational_reserve_pence: 100,
      operational_reserve_status: "ACTIVE",
      final_company_available_pence: 4900,
    });
    const gate = evaluateCompanyTransferExecutionGate({
      amount_pence: 100,
      funding_snapshot: snap,
      live_company_transfer_execution_enabled: false,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason_codes).toContain(
      COMPANY_TRANSFER_GATE_REASON.LIVE_EXECUTION_DISABLED,
    );
  });

  it("self-approval disabled by default", () => {
    expect(assertCompanyTransferSelfApprovalPolicy({
      requester_id: "a",
      approver_id: "a",
    }).ok).toBe(false);
    expect(assertCompanyTransferSelfApprovalPolicy({
      requester_id: "a",
      approver_id: "b",
    }).ok).toBe(true);
    expect(assertCompanyTransferSelfApprovalPolicy({
      requester_id: "a",
      approver_id: "a",
      allow_self_approval: true,
    }).ok).toBe(true);
  });

  it("allows DRAFT → AWAITING_APPROVAL → BLOCKED", () => {
    expect(canTransitionCompanyTransferStatus({
      from: "DRAFT",
      to: "AWAITING_APPROVAL",
    })).toBe(true);
    expect(canTransitionCompanyTransferStatus({
      from: "AWAITING_APPROVAL",
      to: "BLOCKED",
    })).toBe(true);
    expect(canTransitionCompanyTransferStatus({
      from: "DRAFT",
      to: "COMPLETED",
    })).toBe(false);
  });
});
