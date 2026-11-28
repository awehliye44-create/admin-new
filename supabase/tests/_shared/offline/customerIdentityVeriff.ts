/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Customer identity helpers for Edge functions.
 * Approval only via Admin decide RPC — never trust client verified:true.
 */

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";


export function mapVeriffDecisionStatus(
  raw: string | null | undefined,
): "approved" | "declined" | "resubmission_requested" | "expired" | "processing" {
  const s = (raw ?? "").toLowerCase().trim();
  if (s === "approved" || s === "success") return "approved";
  if (s === "declined" || s === "rejected") return "declined";
  if (s === "resubmission_requested" || s === "resubmission") {
    return "resubmission_requested";
  }
  if (s === "expired" || s === "abandoned") return "expired";
  return "processing";
}

export * from "../../../functions/_shared/customerIdentityVeriff.ts";
