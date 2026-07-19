import { describe, expect, it } from "vitest";
import {
  buildCompanyTransferPaymentReference,
  formatCompanyTransferReferenceDay,
  isValidCompanyTransferPaymentReference,
  previewCompanyTransferPaymentReference,
  resolveCompanyTransferPaymentReferenceKind,
  resolveCompanyTransferProviderReference,
  sanitizeCompanyTransferStatementReference,
} from "../../../shared/companyTransferPaymentReferenceSSOT";

describe("companyTransferPaymentReferenceSSOT", () => {
  it("maps certification vs normal kinds", () => {
    expect(resolveCompanyTransferPaymentReferenceKind("COMPANY_OUTGOING")).toBe("CT");
    expect(resolveCompanyTransferPaymentReferenceKind("ONE_OFF")).toBe("CT");
    expect(resolveCompanyTransferPaymentReferenceKind("CERTIFICATION")).toBe("CERT");
    expect(resolveCompanyTransferPaymentReferenceKind("CERT")).toBe("CERT");
  });

  it("builds ONECAB-CT / ONECAB-CERT formats under Revolut length", () => {
    const ct = buildCompanyTransferPaymentReference({
      kind: "CT",
      yymmdd: "260719",
      seq: 1,
    });
    expect(ct).toBe("ONECAB-CT-260719-000001");
    expect(ct.length).toBeLessThanOrEqual(40);
    expect(isValidCompanyTransferPaymentReference(ct)).toBe(true);

    const cert = buildCompanyTransferPaymentReference({
      kind: "CERT",
      yymmdd: "260719",
      seq: 12,
    });
    expect(cert).toBe("ONECAB-CERT-260719-000012");
    expect(isValidCompanyTransferPaymentReference(cert)).toBe(true);
  });

  it("pads sequence and rejects invalid refs", () => {
    expect(
      buildCompanyTransferPaymentReference({ kind: "CT", yymmdd: "260719", seq: 42 }),
    ).toBe("ONECAB-CT-260719-000042");
    expect(isValidCompanyTransferPaymentReference("ONECAB CERT 001")).toBe(false);
    expect(isValidCompanyTransferPaymentReference("")).toBe(false);
  });

  it("previews without consuming a real sequence", () => {
    const preview = previewCompanyTransferPaymentReference({
      transfer_type_or_kind: "CERTIFICATION",
      at: new Date("2026-07-19T12:00:00Z"),
    });
    expect(preview).toMatch(/^ONECAB-CERT-\d{6}-######$/);
  });

  it("formats Europe/London YYMMDD", () => {
    const day = formatCompanyTransferReferenceDay(new Date("2026-07-19T12:00:00Z"));
    expect(day).toMatch(/^\d{6}$/);
  });

  it("provider reference always prefers immutable SSOT payment_reference", () => {
    expect(resolveCompanyTransferProviderReference({
      payment_reference: "ONECAB-CT-260719-000001",
      statement_reference: "CUSTOM MEMO",
      transfer_ref: "COT-ABC",
    })).toBe("ONECAB-CT-260719-000001");

    expect(resolveCompanyTransferProviderReference({
      payment_reference: null,
      transfer_ref: "COT-FALLBACK",
    })).toBe("COT-FALLBACK");
  });

  it("sanitizes optional statement reference", () => {
    expect(sanitizeCompanyTransferStatementReference("  ")).toBeNull();
    expect(sanitizeCompanyTransferStatementReference("  hello  ")).toBe("hello");
    expect(sanitizeCompanyTransferStatementReference("x".repeat(120))?.length).toBe(100);
  });
});
