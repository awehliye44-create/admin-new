import { describe, expect, it } from "vitest";
import {
  COMPANY_TRANSFER_CERTIFICATION_DEFAULTS,
  COMPANY_TRANSFER_FORM_FIELD_HELP,
  buildCompanyTransferDraftSummary,
  formatCompanyTransferPenceAsGbp,
  validateCompanyTransferDraftForm,
} from "../../../shared/companyTransferFormUxSSOT";

const baseForm = {
  payee_id: "payee-1",
  recipient_name: "ONECAB Limited",
  category: "DIRECTOR_SALARY",
  money_source: "COMPANY_BALANCE",
  source_account: "Main",
  destination_account: "•••• 3778",
  amount_pence: "1",
  approved_amount_pence: "",
  payment_reference: "ONECAB CERT 001",
  scheduled_at: "",
  currency: "GBP",
  service_area_id: "sa-1",
  cost_centre: "",
  provider: "revolut_business",
  attachment_url: "",
  purpose: "£0.01 company transfer certification.",
  notes: "",
  transfer_kind: "CERTIFICATION",
  start_mode: "DRAFT",
};

describe("companyTransferFormUxSSOT", () => {
  it("converts pence to live GBP display", () => {
    expect(formatCompanyTransferPenceAsGbp(1)).toBe("£0.01");
    expect(formatCompanyTransferPenceAsGbp(100)).toBe("£1.00");
    expect(formatCompanyTransferPenceAsGbp(1474)).toBe("£14.74");
  });

  it("provides helper text for every required field", () => {
    for (const key of [
      "saved_payee",
      "category",
      "amount_pence",
      "payment_reference",
      "currency",
      "service_area",
      "provider",
      "purpose",
    ] as const) {
      expect(COMPANY_TRANSFER_FORM_FIELD_HELP[key].length).toBeGreaterThan(20);
    }
  });

  it("validates certification draft and blocks incomplete fields", () => {
    const ok = validateCompanyTransferDraftForm({
      form: baseForm,
      payee_provider_verified: true,
      payee_currency: "GBP",
    });
    expect(ok.ok).toBe(true);
    expect(ok.gbp_display).toBe("£0.01");

    const missing = validateCompanyTransferDraftForm({
      form: { ...baseForm, payee_id: "", payment_reference: "", purpose: "", amount_pence: "0" },
      payee_provider_verified: false,
    });
    expect(missing.ok).toBe(false);
    expect(missing.byField.payee_id).toMatch(/saved payee/i);
    expect(missing.byField.payment_reference).toMatch(/reference/i);
    expect(missing.byField.purpose).toMatch(/purpose/i);
    expect(missing.byField.amount_pence).toMatch(/pence/i);
  });

  it("blocks unverified payee with field-level message", () => {
    const v = validateCompanyTransferDraftForm({
      form: baseForm,
      payee_provider_verified: false,
    });
    expect(v.ok).toBe(false);
    expect(v.byField.payee_id).toMatch(/linked to Revolut/i);
  });

  it("requires schedule only for SCHEDULED transfers", () => {
    const scheduled = validateCompanyTransferDraftForm({
      form: { ...baseForm, transfer_kind: "SCHEDULED", scheduled_at: "" },
      payee_provider_verified: true,
    });
    expect(scheduled.byField.scheduled_at).toMatch(/required/i);

    const oneOff = validateCompanyTransferDraftForm({
      form: { ...baseForm, transfer_kind: "ONE_OFF", scheduled_at: "" },
      payee_provider_verified: true,
    });
    expect(oneOff.byField.scheduled_at).toBeUndefined();
  });

  it("builds review summary for certification draft", () => {
    const summary = buildCompanyTransferDraftSummary({
      recipient_name: "ONECAB Limited",
      masked_account: "•••• 3778",
      category: COMPANY_TRANSFER_CERTIFICATION_DEFAULTS.category,
      amount_pence: 1,
      payment_reference: COMPANY_TRANSFER_CERTIFICATION_DEFAULTS.payment_reference,
      money_source: "COMPANY_BALANCE",
      provider: "revolut_business",
      service_area_name: "Milton Keynes",
      is_certification: true,
    });
    expect(summary.lines.find((l) => l.label === "Amount")?.value).toBe("£0.01");
    expect(summary.execution_note).toMatch(/no money moves/i);
    expect(summary.lines.find((l) => l.label === "Category")?.value).toMatch(/certification/i);
  });
});
