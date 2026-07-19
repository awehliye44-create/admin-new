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
  payment_reference: "",
  statement_reference: "",
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

  it("provides helper text for required + auto reference fields", () => {
    for (const key of [
      "saved_payee",
      "category",
      "amount_pence",
      "payment_reference",
      "statement_reference",
      "currency",
      "service_area",
      "provider",
      "purpose",
    ] as const) {
      expect(COMPANY_TRANSFER_FORM_FIELD_HELP[key].length).toBeGreaterThan(20);
    }
  });

  it("validates certification draft without requiring admin-typed payment reference", () => {
    const ok = validateCompanyTransferDraftForm({
      form: baseForm,
      payee_provider_verified: true,
      payee_currency: "GBP",
    });
    expect(ok.ok).toBe(true);
    expect(ok.gbp_display).toBe("£0.01");
    expect(ok.byField.payment_reference).toBeUndefined();

    const missing = validateCompanyTransferDraftForm({
      form: { ...baseForm, payee_id: "", payment_reference: "", purpose: "", amount_pence: "0" },
      payee_provider_verified: false,
    });
    expect(missing.ok).toBe(false);
    expect(missing.byField.payee_id).toMatch(/saved payee/i);
    expect(missing.byField.payment_reference).toBeUndefined();
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

  it("certification defaults do not invent a payment reference", () => {
    expect(
      "payment_reference" in COMPANY_TRANSFER_CERTIFICATION_DEFAULTS,
    ).toBe(false);
  });

  it("draft summary shows auto-assigned reference messaging", () => {
    const summary = buildCompanyTransferDraftSummary({
      recipient_name: "ONECAB Limited",
      masked_account: "•••• 3778",
      category: "DIRECTOR_SALARY",
      amount_pence: 1,
      payment_reference: "",
      money_source: "COMPANY_BALANCE",
      provider: "revolut_business",
      service_area_name: "Milton Keynes",
      is_certification: true,
    });
    expect(summary.lines.find((l) => l.label === "Payment reference")?.value).toMatch(
      /automatically/i,
    );
  });
});
