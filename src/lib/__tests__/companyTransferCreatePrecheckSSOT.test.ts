import { describe, expect, it } from "vitest";
import {
  companyFundsPrecheckPasses,
  evaluateCompanyTransferCreatePrecheck,
} from "../../../shared/companyTransferCreatePrecheckSSOT";
import { evaluatePreDraftCompanyFundsGate } from "../../../shared/companyTransferDraftValidationSSOT";
import { COMPANY_TRANSFER_CERTIFICATION_DEFAULTS } from "../../../shared/companyTransferFormUxSSOT";

const baseForm = {
  payee_id: "",
  recipient_name: "",
  category: COMPANY_TRANSFER_CERTIFICATION_DEFAULTS.category,
  money_source: "COMPANY_BALANCE",
  source_account: "Revolut …12345678",
  destination_account: "",
  amount_pence: "1",
  approved_amount_pence: "",
  payment_reference: "",
  statement_reference: "",
  scheduled_at: "",
  currency: "GBP",
  service_area_id: "sa-1",
  cost_centre: "",
  provider: "revolut_business",
  attachment_url: "",
  purpose: COMPANY_TRANSFER_CERTIFICATION_DEFAULTS.purpose,
  notes: "",
  transfer_kind: "CERTIFICATION",
  start_mode: "DRAFT",
};

const companyBalance774 = {
  driver_payout_funding_status: "OK" as const,
  funding_gap_pence: 0,
  status: "LIVE" as const,
  status_code: "AVAILABLE" as const,
  currency: "GBP",
  service_area_id: "sa-1",
  generated_at: new Date().toISOString(),
  last_verified_at: null,
  last_provider_sync_at: null,
  source_account_id: "rev-acc-1",
  source_account_label: "Revolut Business",
  connection_status: "AVAILABLE",
  connection_health: "AVAILABLE",
  company_ledger_balance_pence: 10000,
  provider_cash_balance_pence: 10000,
  provider_current_balance_pence: 10000,
  provider_available_balance_pence: 10000,
  driver_liability_pence: 1000,
  driver_payout_reserved_pence: 0,
  customer_refund_reserved_pence: 0,
  approved_company_payables_pence: 0,
  operational_reserve_pence: 500,
  company_available_for_transfer_pence: 774,
  final_company_available_pence: 774,
  company_available_before_operational_reserve_pence: 1274,
  classified_company_cash_pence: 2000,
  transferable_base_pence: 1274,
  approved_payables_pending_pence: 0,
  evidence_status: "CONFIRMED" as const,
  unavailable_reason: null,
  source_label: "test",
  excludes_driver_wallet: true,
  sections: {
    operational_reserve: {
      status: "ACTIVE" as const,
      amount_pence: 500,
      currency: "GBP",
      reason_code: null,
    },
  },
};

describe("companyTransferCreatePrecheckSSOT", () => {
  it("company funds PASS for Available £7.74 (774p) and Requested £0.01 (1p)", () => {
    expect(companyFundsPrecheckPasses({
      available_company_funds_pence: 774,
      requested_pence: 1,
    })).toBe(true);

    const gate = evaluatePreDraftCompanyFundsGate({
      available_company_funds_pence: 774,
      requested_pence: 1,
    });
    expect(gate.ok).toBe(true);
    expect(gate.reason).toBe("OK");
    expect(gate.shortfall_pence).toBe(0);
  });

  it("first visible error is Select a saved payee when payee missing (not funds)", () => {
    const precheck = evaluateCompanyTransferCreatePrecheck({
      form: baseForm,
      payee_provider_verified: false,
      company_balance: companyBalance774 as any,
      live_company_transfer_execution_enabled: false,
    });

    expect(precheck.first_visible_error).toBe("Select a saved payee.");
    expect(precheck.first_failing?.id).toBe("payee_selected");

    const funds = precheck.validators.find((v) => v.id === "requested_amount");
    expect(funds?.ok).toBe(true);
    expect(funds?.evidence?.requested_pence).toBe(1);
    expect(funds?.evidence?.available_company_funds_pence).toBe(774);

    const payee = precheck.validators.find((v) => v.id === "payee_selected");
    expect(payee?.ok).toBe(false);
  });

  it("reports every validator independently", () => {
    const precheck = evaluateCompanyTransferCreatePrecheck({
      form: { ...baseForm, payee_id: "payee-1" },
      payee_provider_verified: true,
      company_balance: companyBalance774 as any,
      live_company_transfer_execution_enabled: false,
    });

    const byId = Object.fromEntries(precheck.validators.map((v) => [v.id, v]));
    expect(byId.payee_selected.ok).toBe(true);
    expect(byId.payee_provider_verified.ok).toBe(true);
    expect(byId.company_funding_account.ok).toBe(true);
    expect(byId.available_company_funds.ok).toBe(true);
    expect(byId.requested_amount.ok).toBe(true);
    expect(byId.currency.ok).toBe(true);
    expect(byId.reserve_policy.ok).toBe(true);
    expect(byId.company_reconciliation.ok).toBe(true);
    expect(byId.company_live_execution.ok).toBe(true);
    expect(byId.approval_policy.ok).toBe(true);
    expect(precheck.ok).toBe(true);
  });

  it("does not label AMOUNT_INVALID as INSUFFICIENT_COMPANY_FUNDS", () => {
    const gate = evaluatePreDraftCompanyFundsGate({
      available_company_funds_pence: 774,
      requested_pence: 0,
    });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe("AMOUNT_INVALID");
  });

  it("uses card available field when final is lower stale 0", () => {
    const precheck = evaluateCompanyTransferCreatePrecheck({
      form: { ...baseForm, payee_id: "payee-1", amount_pence: "1" },
      payee_provider_verified: true,
      company_balance: ({
        ...companyBalance774,
        final_company_available_pence: 0,
        company_available_for_transfer_pence: 774,
      },
      live_company_transfer_execution_enabled: false,
    });
    expect(precheck.available_company_funds_pence).toBe(774);
    expect(precheck.validators.find((v) => v.id === "requested_amount")?.ok).toBe(true);
  });
});
