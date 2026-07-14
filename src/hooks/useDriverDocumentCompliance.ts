/**
 * Canonical driver document compliance — reads the server SSOT view
 * (`driver_document_compliance_ssot`) via `get_driver_document_compliance`.
 *
 * Both Admin and the Driver App must consume this SSOT. Never recompute
 * expiry client-side.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type ExpiryStatus =
  | "missing"
  | "pending"
  | "approved_valid"
  | "expiring_soon"
  | "expired"
  | "rejected"
  | "superseded";

export interface DriverDocumentComplianceRow {
  driver_id: string;
  document_type_id: string;
  document_type_key: string;
  display_name: string;
  is_required: boolean;
  has_expiry: boolean;
  document_id: string | null;
  approval_status: string | null;
  expiry_date: string | null;
  file_url: string | null;
  last_updated_at: string | null;
  replacement_document_id: string | null;
  is_current: boolean;
  is_superseded: boolean;
  expiry_status: ExpiryStatus;
  days_until_expiry: number | null;
  blocks_online: boolean;
}

export function useDriverDocumentCompliance(driverId: string | null | undefined) {
  return useQuery({
    queryKey: ["driver-document-compliance", driverId],
    enabled: !!driverId,
    staleTime: 30_000,
    queryFn: async (): Promise<DriverDocumentComplianceRow[]> => {
      const { data, error } = await supabase.rpc("get_driver_document_compliance", {
        _driver_id: driverId!,
      });
      if (error) throw error;
      return (data ?? []) as DriverDocumentComplianceRow[];
    },
  });
}

/** Aggregate compliance state derived from server rows. */
export function summarizeCompliance(rows: DriverDocumentComplianceRow[]) {
  const by = (s: ExpiryStatus) => rows.filter((r) => r.expiry_status === s).length;
  return {
    expired: by("expired"),
    expiring_soon: by("expiring_soon"),
    rejected: by("rejected"),
    pending: by("pending"),
    missing: by("missing"),
    approved_valid: by("approved_valid"),
    blocks_online: rows.some((r) => r.blocks_online),
  };
}

/** Human-readable validity label used by Admin (Review vs Validity split). */
export function validityLabel(row: DriverDocumentComplianceRow): string {
  if (!row.has_expiry) return "N/A";
  if (row.expiry_status === "expired" && row.days_until_expiry != null) {
    return `Expired ${Math.abs(row.days_until_expiry)}d ago`;
  }
  if (row.expiry_status === "expiring_soon" && row.days_until_expiry != null) {
    return `Expiring in ${row.days_until_expiry}d`;
  }
  if (row.expiry_status === "approved_valid") return "Valid";
  return "—";
}

/** Review status = the raw admin decision, decoupled from validity. */
export function reviewLabel(row: DriverDocumentComplianceRow): string {
  if (row.expiry_status === "missing") return "Not uploaded";
  const s = (row.approval_status ?? "").toLowerCase();
  if (s === "approved") return "Approved";
  if (s === "rejected" || s === "declined") return "Rejected";
  if (s === "pending" || s === "uploaded" || s === "submitted") return "Pending review";
  return row.approval_status ?? "—";
}
