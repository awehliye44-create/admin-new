/**
 * #93A / #103 — Idempotent local coverage-mirror reconcile (evidence only).
 *
 * Advances payment_sessions.total_authorised_amount_pence from PSA confirmed totals
 * and/or provider retrieve. Never POSTs. Never invents or rewrites original hold.
 * Reports authorised_promoted ambiguity in metadata for P4 — no bulk repair.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  buildAuthorisationMirrorPatch,
  classifyAuthorisationProjection,
} from "./authorisationProjectionSSOT.ts";
import { isConfirmedIncrementRowStatus } from "./revolutIncrementAuthorisationSSOT.ts";
import {
  retrieveRevolutOrder,
  revolutProviderAuthorisedTotalPence,
} from "./revolutOrders.ts";
import type { ProviderEnvironment } from "./paymentProviders/types.ts";

export type AuthorisationProjectionReconcileResult = {
  payment_session_id: string;
  action:
    | "noop"
    | "total_advanced"
    | "ambiguity_reported"
    | "skipped_inflight"
    | "skipped_no_evidence";
  previous_total_pence: number;
  next_total_pence: number;
  projection_class: string;
  provider_confirmed_pence: number | null;
  psa_confirmed_pence: number | null;
};

function nonNeg(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function reconcileAuthorisationProjectionForSession(
  supabase: SupabaseClient,
  args: {
    paymentSessionId: string;
    environment?: ProviderEnvironment | null;
    secretKey?: string | null;
    /** When true, may GET provider order. Default true when credentials present. */
    allowProviderRetrieve?: boolean;
    verifiedBy?: string;
  },
): Promise<AuthorisationProjectionReconcileResult> {
  const sessionId = String(args.paymentSessionId).trim();
  const verifiedBy = args.verifiedBy ?? "authorisation_projection_reconcile_103";

  const { data: session } = await supabase
    .from("payment_sessions")
    .select(
      "id, authorised_amount_pence, original_authorised_pence, total_authorised_amount_pence, "
        + "provider_order_id, provider_state, metadata, financial_operation_state, "
        + "provider_post_inflight",
    )
    .eq("id", sessionId)
    .maybeSingle();

  if (!session) {
    return {
      payment_session_id: sessionId,
      action: "skipped_no_evidence",
      previous_total_pence: 0,
      next_total_pence: 0,
      projection_class: "other",
      provider_confirmed_pence: null,
      psa_confirmed_pence: null,
    };
  }

  if (session.provider_post_inflight === true) {
    return {
      payment_session_id: sessionId,
      action: "skipped_inflight",
      previous_total_pence: nonNeg(session.total_authorised_amount_pence),
      next_total_pence: nonNeg(session.total_authorised_amount_pence),
      projection_class: "other",
      provider_confirmed_pence: null,
      psa_confirmed_pence: null,
    };
  }

  const { data: psaRows } = await supabase
    .from("payment_session_authorisations")
    .select("status, provider_confirmed_total_pence, cumulative_total_authorised_pence")
    .eq("payment_session_id", sessionId);

  let psaConfirmed = 0;
  let confirmedIncrementCount = 0;
  for (const row of psaRows ?? []) {
    if (!isConfirmedIncrementRowStatus(row.status)) continue;
    confirmedIncrementCount += 1;
    psaConfirmed = Math.max(
      psaConfirmed,
      nonNeg(row.provider_confirmed_total_pence),
      nonNeg(row.cumulative_total_authorised_pence),
    );
  }

  let providerConfirmed: number | null = null;
  const allowRetrieve = args.allowProviderRetrieve !== false
    && Boolean(args.environment)
    && Boolean(args.secretKey)
    && Boolean(session.provider_order_id);
  if (allowRetrieve) {
    try {
      const order = await retrieveRevolutOrder(
        args.environment!,
        args.secretKey!,
        String(session.provider_order_id),
      );
      const fromProvider = revolutProviderAuthorisedTotalPence(order as Record<string, unknown>);
      if (fromProvider != null && fromProvider > 0) providerConfirmed = fromProvider;
    } catch {
      // Evidence-only: missing retrieve leaves PSA as authority for mirror advance.
    }
  }

  const evidenceTotal = Math.max(psaConfirmed, providerConfirmed ?? 0);
  const previousTotal = nonNeg(session.total_authorised_amount_pence);
  const projectionClass = classifyAuthorisationProjection({
    authorised_amount_pence: session.authorised_amount_pence,
    total_authorised_amount_pence: session.total_authorised_amount_pence,
    original_authorised_pence: session.original_authorised_pence,
    psaConfirmedTotalPence: psaConfirmed > 0 ? psaConfirmed : null,
    confirmedIncrementCount,
  });

  const meta = (session.metadata && typeof session.metadata === "object")
    ? { ...(session.metadata as Record<string, unknown>) }
    : {};

  if (evidenceTotal <= 0) {
    if (projectionClass === "authorised_promoted" && meta.auth_projection_ambiguity_103 !== projectionClass) {
      await supabase
        .from("payment_sessions")
        .update({
          metadata: {
            ...meta,
            auth_projection_ambiguity_103: projectionClass,
            auth_projection_ambiguity_at: new Date().toISOString(),
            auth_projection_ambiguity_note:
              "Original hold appears promoted to live total; P4 review — do not invent original from provider.",
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", sessionId);
      return {
        payment_session_id: sessionId,
        action: "ambiguity_reported",
        previous_total_pence: previousTotal,
        next_total_pence: previousTotal,
        projection_class: projectionClass,
        provider_confirmed_pence: providerConfirmed,
        psa_confirmed_pence: psaConfirmed > 0 ? psaConfirmed : null,
      };
    }
    return {
      payment_session_id: sessionId,
      action: "skipped_no_evidence",
      previous_total_pence: previousTotal,
      next_total_pence: previousTotal,
      projection_class: projectionClass,
      provider_confirmed_pence: providerConfirmed,
      psa_confirmed_pence: psaConfirmed > 0 ? psaConfirmed : null,
    };
  }

  const patch = buildAuthorisationMirrorPatch({
    existingAuthorisedPence: session.authorised_amount_pence,
    existingTotalAuthorisedPence: session.total_authorised_amount_pence,
    confirmedCoveragePence: evidenceTotal,
    seedOriginalIfMissing: false,
  });

  const nextTotal = nonNeg(patch.total_authorised_amount_pence) || previousTotal;
  const nowIso = new Date().toISOString();
  const nextMeta = {
    ...meta,
    last_auth_projection_reconcile_at: nowIso,
    last_auth_projection_reconcile_by: verifiedBy,
    last_auth_projection_class: projectionClass,
    ...(projectionClass === "authorised_promoted"
      ? {
        auth_projection_ambiguity_103: projectionClass,
        auth_projection_ambiguity_at: nowIso,
        auth_projection_ambiguity_note:
          "Original hold appears promoted to live total; P4 review — do not invent original from provider.",
      }
      : {}),
  };

  if (nextTotal <= previousTotal && projectionClass !== "authorised_promoted") {
    return {
      payment_session_id: sessionId,
      action: "noop",
      previous_total_pence: previousTotal,
      next_total_pence: previousTotal,
      projection_class: projectionClass,
      provider_confirmed_pence: providerConfirmed,
      psa_confirmed_pence: psaConfirmed > 0 ? psaConfirmed : null,
    };
  }

  await supabase
    .from("payment_sessions")
    .update({
      ...(nextTotal > previousTotal ? { total_authorised_amount_pence: nextTotal } : {}),
      provider_state_verified_at: nowIso,
      provider_state_verified_by: verifiedBy,
      metadata: nextMeta,
      updated_at: nowIso,
    })
    .eq("id", sessionId);

  return {
    payment_session_id: sessionId,
    action: nextTotal > previousTotal
      ? "total_advanced"
      : (projectionClass === "authorised_promoted" ? "ambiguity_reported" : "noop"),
    previous_total_pence: previousTotal,
    next_total_pence: nextTotal,
    projection_class: projectionClass,
    provider_confirmed_pence: providerConfirmed,
    psa_confirmed_pence: psaConfirmed > 0 ? psaConfirmed : null,
  };
}

/**
 * Sweep helper: reconcile a bounded batch of recently incremented sessions.
 * No provider POST. Optional retrieve when credentials supplied.
 */
export async function reconcileAuthorisationProjectionsBatch(
  supabase: SupabaseClient,
  args: {
    limit?: number;
    environment?: ProviderEnvironment | null;
    secretKey?: string | null;
    lookbackHours?: number;
  } = {},
): Promise<{ scanned: number; results: AuthorisationProjectionReconcileResult[] }> {
  const limit = Math.min(50, Math.max(1, Math.round(Number(args.limit ?? 20))));
  const lookbackHours = Math.min(168, Math.max(1, Math.round(Number(args.lookbackHours ?? 48))));
  const since = new Date(Date.now() - lookbackHours * 3600_000).toISOString();

  const { data: psa } = await supabase
    .from("payment_session_authorisations")
    .select("payment_session_id, status, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(200);

  const sessionIds: string[] = [];
  const seen = new Set<string>();
  for (const row of psa ?? []) {
    const id = String(row.payment_session_id ?? "").trim();
    if (!id || seen.has(id)) continue;
    if (!isConfirmedIncrementRowStatus(row.status)
      && String(row.status ?? "").toUpperCase() !== "ADDITIONAL_AUTHORISATION_PENDING"
      && String(row.status ?? "").toLowerCase() !== "pending") {
      continue;
    }
    seen.add(id);
    sessionIds.push(id);
    if (sessionIds.length >= limit) break;
  }

  const results: AuthorisationProjectionReconcileResult[] = [];
  for (const id of sessionIds) {
    results.push(
      await reconcileAuthorisationProjectionForSession(supabase, {
        paymentSessionId: id,
        environment: args.environment,
        secretKey: args.secretKey,
        allowProviderRetrieve: Boolean(args.environment && args.secretKey),
        verifiedBy: "sweep_auth_projection_103",
      }),
    );
  }
  return { scanned: sessionIds.length, results };
}
