/**
 * Contract tests for the server SSOT rows consumed by `useDriverDocumentCompliance`.
 * Backend calculation is authoritative — these tests lock the client mapping helpers
 * that turn a `DriverDocumentComplianceRow` into UI labels.
 */
import { describe, it, expect } from "vitest";
import {
  reviewLabel,
  validityLabel,
  summarizeCompliance,
  DriverDocumentComplianceRow,
} from "@/hooks/useDriverDocumentCompliance";

function row(overrides: Partial<DriverDocumentComplianceRow>): DriverDocumentComplianceRow {
  return {
    driver_id: "d1",
    document_type_id: "dt1",
    document_type_key: "phv_license",
    display_name: "PHV",
    is_required: true,
    has_expiry: true,
    document_id: "doc1",
    approval_status: "approved",
    expiry_date: "2026-07-31",
    file_url: null,
    last_updated_at: null,
    replacement_document_id: null,
    is_current: true,
    is_superseded: false,
    expiry_status: "approved_valid",
    days_until_expiry: 17,
    blocks_online: false,
    ...overrides,
  };
}

describe("driver document compliance SSOT mapping", () => {
  it("approved + valid → Review=Approved, Validity=Valid", () => {
    const r = row({});
    expect(reviewLabel(r)).toBe("Approved");
    expect(validityLabel(r)).toBe("Valid");
  });

  it("approved + expiring soon → Validity shows days", () => {
    const r = row({ expiry_status: "expiring_soon", days_until_expiry: 2 });
    expect(reviewLabel(r)).toBe("Approved");
    expect(validityLabel(r)).toBe("Expiring in 2d");
  });

  it("approved + expired → Review still Approved, Validity shows days ago", () => {
    const r = row({ expiry_status: "expired", days_until_expiry: -3 });
    expect(reviewLabel(r)).toBe("Approved");
    expect(validityLabel(r)).toBe("Expired 3d ago");
  });

  it("rejected → Review=Rejected regardless of expiry", () => {
    const r = row({ expiry_status: "rejected", approval_status: "rejected" });
    expect(reviewLabel(r)).toBe("Rejected");
  });

  it("missing → Review=Not uploaded, Validity=N/A when no expiry", () => {
    const r = row({
      expiry_status: "missing",
      approval_status: null,
      document_id: null,
      expiry_date: null,
      has_expiry: false,
      days_until_expiry: null,
    });
    expect(reviewLabel(r)).toBe("Not uploaded");
    expect(validityLabel(r)).toBe("N/A");
  });

  it("pending replacement → Review=Pending review", () => {
    const r = row({ expiry_status: "pending", approval_status: "pending" });
    expect(reviewLabel(r)).toBe("Pending review");
  });

  it("summarize counts every expiry_status bucket", () => {
    const s = summarizeCompliance([
      row({ expiry_status: "approved_valid" }),
      row({ expiry_status: "expired", blocks_online: true }),
      row({ expiry_status: "expiring_soon" }),
      row({ expiry_status: "missing", blocks_online: true }),
    ]);
    expect(s.approved_valid).toBe(1);
    expect(s.expired).toBe(1);
    expect(s.expiring_soon).toBe(1);
    expect(s.missing).toBe(1);
    expect(s.blocks_online).toBe(true);
  });
});
