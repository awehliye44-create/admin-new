/**
 * #75A — Bounded historical residual-release evidence reconciliation.
 * Read-only Revolut GET + evidence persist only. Never capture / release / refund / wallet.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  HISTORICAL_RELEASE_EVIDENCE_BACKFILL,
  buildHistoricalReleaseEvidenceIdempotencyKey,
  classifyHistoricalReleaseEvidenceBackfill,
  isEligibleHistoricalReleaseEvidenceSession,
  wouldDowngradeReleaseEvidence,
} from "./historicalReleaseEvidenceBackfillSSOT.ts";
import { safePersistCaptureResidualReleaseEvidence } from "../../_shared/paymentSessionSSOT.ts";
import { RELEASE_EVIDENCE_SOURCE } from "../../_shared/paymentSessionReleaseEvidenceSSOT.ts";
import { retrieveRevolutOrder } from "../../_shared/revolutOrders.ts";
import { resolveRevolutMerchantContext } from "../../_shared/revolutMerchantContext.ts";

export type ReleaseEvidenceReconcileResult = {
  success: boolean;
  scanned: number;
  eligible: number;
  applied: number;
  skipped: number;
  failed: number;
  cohort_total_partial_capture: number;
  results: Array<{
    session_id: string;
    trip_id: string | null;
    provider_order_id: string | null;
    before_status: string | null;
    before_released_amount_pence: number | null;
    after_status: string | null;
    after_released_amount_pence: number | null;
    expected_release_pence: number;
    outcome: "applied" | "skipped" | "failed" | "ineligible";
    reason: string;
  }>;
  error?: string;
};

const DEFAULT_LIMIT = 60;

export async function reconcileHistoricalReleaseEvidence(args: {
  supabase: SupabaseClient;
  limit?: number;
  sessionIds?: string[] | null;
}): Promise<ReleaseEvidenceReconcileResult> {
  const limit = Math.min(Math.max(1, args.limit ?? DEFAULT_LIMIT), 100);
  const results: ReleaseEvidenceReconcileResult["results"] = [];

  // Cohort size for 49 vs classified reporting.
  const { count: cohortCount } = await args.supabase
    .from("payment_sessions")
    .select("id", { count: "exact", head: true })
    .gt("captured_amount_pence", 0)
    .filter("authorised_amount_pence", "gt", 0);

  let query = args.supabase
    .from("payment_sessions")
    .select(
      "id, trip_id, provider_order_id, payment_provider, authorised_amount_pence, total_authorised_amount_pence, captured_amount_pence, released_amount_pence, release_evidence_status, status, provider_state",
    )
    .eq("payment_provider", "revolut")
    .gt("captured_amount_pence", 0)
    .order("captured_at", { ascending: false })
    .limit(limit * 3);

  if (args.sessionIds && args.sessionIds.length > 0) {
    query = args.supabase
      .from("payment_sessions")
      .select(
        "id, trip_id, provider_order_id, payment_provider, authorised_amount_pence, total_authorised_amount_pence, captured_amount_pence, released_amount_pence, release_evidence_status, status, provider_state",
      )
      .in("id", args.sessionIds);
  }

  const { data: rows, error } = await query;
  if (error) {
    return {
      success: false,
      scanned: 0,
      eligible: 0,
      applied: 0,
      skipped: 0,
      failed: 0,
      cohort_total_partial_capture: cohortCount ?? 0,
      results: [],
      error: error.message,
    };
  }

  const merchant = await resolveRevolutMerchantContext(args.supabase, "live");
  let eligible = 0;
  let applied = 0;
  let skipped = 0;
  let failed = 0;
  let scanned = 0;

  for (const row of rows ?? []) {
    if (results.length >= limit && !(args.sessionIds && args.sessionIds.length > 0)) break;
    scanned += 1;
    const auth = Math.round(Number(
      row.total_authorised_amount_pence ?? row.authorised_amount_pence ?? 0,
    ));
    const cap = Math.round(Number(row.captured_amount_pence ?? 0));
    if (!(auth > cap && cap > 0)) continue;

    const eligibility = isEligibleHistoricalReleaseEvidenceSession(row);
    if (!eligibility.eligible) {
      results.push({
        session_id: String(row.id),
        trip_id: row.trip_id ? String(row.trip_id) : null,
        provider_order_id: row.provider_order_id ? String(row.provider_order_id) : null,
        before_status: row.release_evidence_status != null
          ? String(row.release_evidence_status)
          : null,
        before_released_amount_pence: row.released_amount_pence == null
          ? null
          : Math.round(Number(row.released_amount_pence)),
        after_status: row.release_evidence_status != null
          ? String(row.release_evidence_status)
          : null,
        after_released_amount_pence: row.released_amount_pence == null
          ? null
          : Math.round(Number(row.released_amount_pence)),
        expected_release_pence: Math.max(0, auth - cap),
        outcome: "ineligible",
        reason: eligibility.reason,
      });
      continue;
    }
    eligible += 1;

    const orderId = String(row.provider_order_id ?? "").trim();
    let retrieveSucceeded = false;
    let providerPayload: Record<string, unknown> | null = null;
    let httpStatus: number | null = null;
    try {
      const order = await retrieveRevolutOrder(
        merchant.environment,
        merchant.secretKey,
        orderId,
      );
      retrieveSucceeded = true;
      providerPayload = order as unknown as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("404")) httpStatus = 404;
      retrieveSucceeded = false;
    }

    const classified = classifyHistoricalReleaseEvidenceBackfill({
      sessionAuthorisedPence: auth,
      sessionCapturedPence: cap,
      providerPayload,
      retrieveSucceeded,
      retrieveHttpStatus: httpStatus,
    });

    if (
      wouldDowngradeReleaseEvidence({
        existingStatus: row.release_evidence_status,
        existingReleasedAmountPence: row.released_amount_pence == null
          ? null
          : Math.round(Number(row.released_amount_pence)),
        nextStatus: classified.release_evidence_status,
        nextReleasedAmountPence: classified.released_amount_pence,
      })
    ) {
      skipped += 1;
      results.push({
        session_id: String(row.id),
        trip_id: row.trip_id ? String(row.trip_id) : null,
        provider_order_id: orderId || null,
        before_status: row.release_evidence_status != null
          ? String(row.release_evidence_status)
          : null,
        before_released_amount_pence: row.released_amount_pence == null
          ? null
          : Math.round(Number(row.released_amount_pence)),
        after_status: row.release_evidence_status != null
          ? String(row.release_evidence_status)
          : null,
        after_released_amount_pence: row.released_amount_pence == null
          ? null
          : Math.round(Number(row.released_amount_pence)),
        expected_release_pence: classified.expected_release_pence,
        outcome: "skipped",
        reason: "would_downgrade_stronger_evidence",
      });
      continue;
    }

    try {
      const persist = await safePersistCaptureResidualReleaseEvidence({
        supabase: args.supabase,
        sessionId: String(row.id),
        providerOrderId: orderId,
        tripId: row.trip_id ? String(row.trip_id) : null,
        authorisedHoldPence: auth,
        capturedAmountPence: cap,
        evidenceSource: RELEASE_EVIDENCE_SOURCE.ADMIN_REFRESH,
        providerPayload,
        retrieveSucceeded,
        persistFee: false,
      });

      const idempotencyKey = buildHistoricalReleaseEvidenceIdempotencyKey({
        sessionId: String(row.id),
        providerOrderId: orderId,
        capturedAmountPence: cap,
        releaseEvidenceStatus: classified.release_evidence_status,
      });

      try {
        await args.supabase.rpc("insert_payment_release_evidence_backfill", {
          p_idempotency_key: idempotencyKey,
          p_payment_session_id: String(row.id),
          p_trip_id: row.trip_id ? String(row.trip_id) : null,
          p_provider_order_id: orderId,
          p_provider_payment_id: classified.provider_payment_id ?? orderId,
          p_backfill_source: HISTORICAL_RELEASE_EVIDENCE_BACKFILL.SOURCE,
          p_backfill_version: HISTORICAL_RELEASE_EVIDENCE_BACKFILL.VERSION,
          p_authorised_amount_pence: auth,
          p_captured_amount_pence: cap,
          p_released_amount_pence: classified.released_amount_pence ?? 0,
          p_comparison_auth_minus_capture_pence: classified.comparison_auth_minus_capture_pence,
          p_release_evidence_status: classified.release_evidence_status,
          p_suggested_status_alias: classified.suggested_alias,
          p_provider_state: classified.provider_state ?? "",
          p_unresolved_reason: classified.unresolved_reason ?? "",
          p_provider_retrieved_at: new Date().toISOString(),
          p_provider_snapshot: providerPayload ?? {},
          p_session_patch_applied: persist?.applied === true,
        });
      } catch (rpcErr) {
        console.warn(
          "[release-evidence-reconcile] audit rpc failed (non-fatal)",
          rpcErr instanceof Error ? rpcErr.message : String(rpcErr),
        );
      }

      if (persist?.skipped) {
        skipped += 1;
        results.push({
          session_id: String(row.id),
          trip_id: row.trip_id ? String(row.trip_id) : null,
          provider_order_id: orderId || null,
          before_status: row.release_evidence_status != null
            ? String(row.release_evidence_status)
            : null,
          before_released_amount_pence: row.released_amount_pence == null
            ? null
            : Math.round(Number(row.released_amount_pence)),
          after_status: persist.release_evidence_status,
          after_released_amount_pence: persist.released_amount_pence,
          expected_release_pence: persist.expected_release_pence,
          outcome: "skipped",
          reason: "idempotent_skip",
        });
      } else {
        applied += 1;
        results.push({
          session_id: String(row.id),
          trip_id: row.trip_id ? String(row.trip_id) : null,
          provider_order_id: orderId || null,
          before_status: row.release_evidence_status != null
            ? String(row.release_evidence_status)
            : null,
          before_released_amount_pence: row.released_amount_pence == null
            ? null
            : Math.round(Number(row.released_amount_pence)),
          after_status: persist?.release_evidence_status
            ?? classified.release_evidence_status,
          after_released_amount_pence: persist?.released_amount_pence
            ?? classified.released_amount_pence,
          expected_release_pence: classified.expected_release_pence,
          outcome: "applied",
          reason: classified.unresolved_reason ?? classified.suggested_alias,
        });
      }
    } catch (err) {
      failed += 1;
      results.push({
        session_id: String(row.id),
        trip_id: row.trip_id ? String(row.trip_id) : null,
        provider_order_id: orderId || null,
        before_status: row.release_evidence_status != null
          ? String(row.release_evidence_status)
          : null,
        before_released_amount_pence: row.released_amount_pence == null
          ? null
          : Math.round(Number(row.released_amount_pence)),
        after_status: row.release_evidence_status != null
          ? String(row.release_evidence_status)
          : null,
        after_released_amount_pence: row.released_amount_pence == null
          ? null
          : Math.round(Number(row.released_amount_pence)),
        expected_release_pence: classified.expected_release_pence,
        outcome: "failed",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    success: true,
    scanned,
    eligible,
    applied,
    skipped,
    failed,
    cohort_total_partial_capture: cohortCount ?? 0,
    results,
  };
}
