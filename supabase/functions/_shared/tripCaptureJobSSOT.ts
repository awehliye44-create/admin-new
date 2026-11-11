/**
 * Durable trip capture job queue for post-complete Revolut capture.
 * Enqueue is awaited on the Driver complete_trip path; processing uses the
 * existing finalize-trip-and-capture invoke (idempotent). waitUntil may only
 * accelerate a row that was already inserted.
 *
 * claim_count: incremented on every claim/reclaim (crash recovery).
 * capture_attempt_count: incremented only immediately before finalize invoke.
 * failed_terminal: always stamps admin_alert_pending; delivery is retryable.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { invokeFinalizeTripCapture } from "./invokeFinalizeTripCapture.ts";
import { applyCompleteTripCaptureOutcome } from "./applyCompleteTripCaptureOutcome.ts";
import { tripProviderOrderId } from "./tripPaymentProviderSSOT.ts";
import { sendAdminNotification } from "./adminNotificationSSOT.ts";
import {
  isFareDurableRecoveryStatus,
  isTipCaptureOutcomeStatus,
} from "./captureOutcomeClassificationSSOT.ts";

export const TRIP_CAPTURE_JOB_MAX_CAPTURE_ATTEMPTS = 12;
/** Preflight / trip-missing terminal uses claim_count, not capture attempts. */
export const TRIP_CAPTURE_JOB_MAX_CLAIMS_WITHOUT_CAPTURE = 24;
export const TRIP_CAPTURE_JOB_CLAIM_TTL_SECONDS = 120;
/** @deprecated use TRIP_CAPTURE_JOB_MAX_CAPTURE_ATTEMPTS */
export const TRIP_CAPTURE_JOB_MAX_ATTEMPTS = TRIP_CAPTURE_JOB_MAX_CAPTURE_ATTEMPTS;

const BUSY_BACKOFF_MS = 15_000;
const RETRYABLE_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000];

export type EnqueueTripCaptureJobResult =
  | { ok: true; inserted: boolean }
  | { ok: false; error: string };

export type ClaimedTripCaptureJob = {
  jobId: string;
  tripId: string;
  tipPence: number;
  claimCount: number;
  captureAttemptCount: number;
  source: string;
  claimToken: string;
};

export type PendingAlertJob = {
  jobId: string;
  tripId: string;
  lastError: string | null;
  lastFinalizeStatus: string | null;
  adminAlertKey: string | null;
  captureAttemptCount: number;
  claimCount: number;
  source: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function backoffMsForCaptureAttempt(captureAttemptCount: number): number {
  const idx = Math.max(
    0,
    Math.min(RETRYABLE_BACKOFF_MS.length - 1, captureAttemptCount - 1),
  );
  return RETRYABLE_BACKOFF_MS[idx] ?? 600_000;
}

export function buildTripCaptureFailedTerminalAlertKey(tripId: string): string {
  return `trip_capture_failed_terminal:${tripId}`;
}

export async function enqueueTripCaptureJob(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    source?: string;
    tipPence?: number;
  },
): Promise<EnqueueTripCaptureJobResult> {
  const tipPence = Math.max(0, Math.floor(Number(args.tipPence ?? 0) || 0));
  const source = String(args.source ?? "stop-workflow:complete_trip").slice(0, 120);
  const { error } = await supabase.from("trip_capture_jobs").insert({
    trip_id: args.tripId,
    status: "queued",
    source,
    tip_pence: tipPence,
    next_attempt_at: new Date().toISOString(),
  });

  if (!error) {
    return { ok: true, inserted: true };
  }

  const code = String((error as { code?: string }).code ?? "");
  const message = String(error.message ?? "");
  // Unique trip_id — already queued / claimed / done. Treat as durable success.
  if (code === "23505" || /duplicate|unique/i.test(message)) {
    return { ok: true, inserted: false };
  }
  return { ok: false, error: message || "enqueue_failed" };
}

export async function stampTripCaptureRequested(
  supabase: SupabaseClient,
  tripId: string,
): Promise<void> {
  const { data } = await supabase
    .from("trips")
    .select("payment_status, payment_hold_status")
    .eq("id", tripId)
    .maybeSingle();
  const status = String(data?.payment_status ?? "").toLowerCase();
  // Do not clobber terminal / shortfall / already-captured outcomes.
  if (
    status.includes("captured") ||
    status.includes("shortfall") ||
    status.includes("recovery") ||
    status === "capture_failed" ||
    status === "canceled" ||
    status === "cancelled"
  ) {
    return;
  }
  await supabase.from("trips").update({
    payment_status: "capture_requested",
    payment_hold_status: "capture_queued",
    updated_at: new Date().toISOString(),
  }).eq("id", tripId);
}

function mapClaimedRow(
  row: unknown,
  claimToken: string,
): ClaimedTripCaptureJob | null {
  const r = asRecord(row);
  if (!r?.job_id || !r?.trip_id) return null;
  return {
    jobId: String(r.job_id),
    tripId: String(r.trip_id),
    tipPence: Math.max(0, Math.floor(Number(r.tip_pence ?? 0) || 0)),
    claimCount: Math.max(0, Math.floor(Number(r.claim_count ?? 0) || 0)),
    captureAttemptCount: Math.max(
      0,
      Math.floor(Number(r.capture_attempt_count ?? 0) || 0),
    ),
    source: String(r.source ?? "trip-capture-job"),
    claimToken,
  };
}

export async function claimTripCaptureJobs(
  supabase: SupabaseClient,
  args?: { limit?: number; claimTtlSeconds?: number },
): Promise<ClaimedTripCaptureJob[]> {
  const claimToken = crypto.randomUUID();
  const { data, error } = await supabase.rpc("claim_trip_capture_jobs", {
    p_claim_token: claimToken,
    p_claim_ttl_seconds: args?.claimTtlSeconds ?? TRIP_CAPTURE_JOB_CLAIM_TTL_SECONDS,
    p_limit: args?.limit ?? 20,
  });
  if (error) {
    console.error("[trip-capture-job] claim_trip_capture_jobs failed", error.message);
    return [];
  }
  const rows = Array.isArray(data) ? data : [];
  return rows
    .map((row) => mapClaimedRow(row, claimToken))
    .filter((j): j is ClaimedTripCaptureJob => Boolean(j));
}

export async function claimTripCaptureJobByTripId(
  supabase: SupabaseClient,
  tripId: string,
  claimTtlSeconds = TRIP_CAPTURE_JOB_CLAIM_TTL_SECONDS,
): Promise<ClaimedTripCaptureJob | null> {
  const claimToken = crypto.randomUUID();
  const { data, error } = await supabase.rpc("claim_trip_capture_job_by_trip_id", {
    p_trip_id: tripId,
    p_claim_token: claimToken,
    p_claim_ttl_seconds: claimTtlSeconds,
  });
  if (error) {
    console.error("[trip-capture-job] claim_by_trip_id failed", {
      trip_id: tripId,
      error: error.message,
    });
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  return mapClaimedRow(row, claimToken);
}

async function bumpCaptureAttempt(
  supabase: SupabaseClient,
  job: ClaimedTripCaptureJob,
): Promise<number> {
  const { data, error } = await supabase.rpc("bump_trip_capture_attempt", {
    p_job_id: job.jobId,
    p_claim_token: job.claimToken,
  });
  if (error) {
    throw new Error(`bump_trip_capture_attempt failed: ${error.message}`);
  }
  const next = Math.max(0, Math.floor(Number(data ?? 0) || 0));
  job.captureAttemptCount = next;
  return next;
}

async function finishJobAttempt(
  supabase: SupabaseClient,
  job: ClaimedTripCaptureJob,
  args: {
    status: "queued" | "done" | "failed_terminal";
    nextAttemptAt?: string | null;
    lastError?: string | null;
    lastFinalizeStatus?: string | null;
    adminAlertKey?: string | null;
  },
): Promise<boolean> {
  const { data, error } = await supabase.rpc("update_trip_capture_job_after_attempt", {
    p_job_id: job.jobId,
    p_claim_token: job.claimToken,
    p_status: args.status,
    p_next_attempt_at: args.nextAttemptAt ?? null,
    p_last_error: args.lastError ?? null,
    p_last_finalize_status: args.lastFinalizeStatus ?? null,
    p_admin_alert_key: args.adminAlertKey ?? null,
  });
  if (error) {
    console.error("[trip-capture-job] update after attempt failed", {
      job_id: job.jobId,
      trip_id: job.tripId,
      error: error.message,
    });
    return false;
  }
  return data === true;
}

/**
 * Deliver a durable admin alert for a failed_terminal job.
 * Deduped by alertKey (sendAdminNotification cooldown + stable key).
 * Returns true only when in-app insert succeeded or cooldown skipped (already alerted).
 * On failure, leaves admin_alert_pending for cron retry.
 */
export async function deliverTripCaptureFailedTerminalAlert(
  supabase: SupabaseClient,
  args: {
    jobId: string;
    tripId: string;
    lastError?: string | null;
    lastFinalizeStatus?: string | null;
    alertKey?: string | null;
    captureAttemptCount?: number;
    claimCount?: number;
  },
): Promise<{ delivered: boolean; skipped?: boolean; reason?: string }> {
  const alertKey = (args.alertKey?.trim() ||
    buildTripCaptureFailedTerminalAlertKey(args.tripId)).slice(0, 200);
  const reason = String(args.lastFinalizeStatus ?? args.lastError ?? "capture_failed")
    .slice(0, 200);
  const detail = String(args.lastError ?? reason).slice(0, 400);
  const tripRef = args.tripId.slice(0, 8);

  try {
    const result = await sendAdminNotification(supabase, {
      type: "TRIP_CAPTURE_FAILED_TERMINAL",
      title: "Trip capture failed — admin recovery required",
      body: `Capture job exhausted retries for trip ${tripRef}… (${reason}). ${detail}`,
      category: "payment",
      priority: "urgent",
      actionUrl: `/payment-sessions?tab=recovery&tripId=${encodeURIComponent(args.tripId)}`,
      actionLabel: "Open Payment Sessions",
      alertKey,
      cooldownMinutes: 60 * 24,
      emailTag: "trip_capture_failed_terminal",
      data: {
        trip_id: args.tripId,
        job_id: args.jobId,
        last_finalize_status: args.lastFinalizeStatus ?? null,
        last_error: args.lastError ?? null,
        capture_attempt_count: args.captureAttemptCount ?? null,
        claim_count: args.claimCount ?? null,
      },
    });

    // Durable in-app row is the SSOT; cooldown skip means alert already exists.
    const delivered = result.skipped === true || result.in_app === true;
    if (!delivered) {
      console.warn("[trip-capture-job] admin alert not durable yet", {
        trip_id: args.tripId,
        job_id: args.jobId,
        in_app: result.in_app ?? false,
        skipped: result.skipped ?? false,
      });
      return { delivered: false, reason: "in_app_insert_failed" };
    }

    const { error } = await supabase.rpc("mark_trip_capture_admin_alert_delivered", {
      p_job_id: args.jobId,
      p_alert_key: alertKey,
    });
    if (error) {
      // Alert may have been written; keep pending so cron can clear after confirm.
      console.warn("[trip-capture-job] mark alert delivered failed", {
        trip_id: args.tripId,
        error: error.message,
      });
      return { delivered: false, reason: "mark_delivered_failed" };
    }
    return {
      delivered: true,
      skipped: result.skipped === true,
      reason: result.skipped ? "cooldown" : "sent",
    };
  } catch (err) {
    console.warn("[trip-capture-job] admin alert threw", {
      trip_id: args.tripId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { delivered: false, reason: "exception" };
  }
}

async function markFailedTerminalAndAlert(
  supabase: SupabaseClient,
  job: ClaimedTripCaptureJob,
  args: {
    lastError: string;
    lastFinalizeStatus: string;
  },
): Promise<{ outcome: "failed_terminal" }> {
  const alertKey = buildTripCaptureFailedTerminalAlertKey(job.tripId);
  const updated = await finishJobAttempt(supabase, job, {
    status: "failed_terminal",
    lastError: args.lastError,
    lastFinalizeStatus: args.lastFinalizeStatus,
    adminAlertKey: alertKey,
  });
  if (!updated) {
    console.error("[trip-capture-job] failed_terminal stamp failed", {
      trip_id: job.tripId,
      job_id: job.jobId,
    });
    // Still attempt alert; pending may be false if stamp failed — best effort log.
  }
  await deliverTripCaptureFailedTerminalAlert(supabase, {
    jobId: job.jobId,
    tripId: job.tripId,
    lastError: args.lastError,
    lastFinalizeStatus: args.lastFinalizeStatus,
    alertKey,
    captureAttemptCount: job.captureAttemptCount,
    claimCount: job.claimCount,
  });
  return { outcome: "failed_terminal" };
}

function isRetryableBusy(finalizeBody: Record<string, unknown> | undefined): boolean {
  const status = String(finalizeBody?.status ?? "").toLowerCase();
  const code = String(finalizeBody?.code ?? "").toUpperCase();
  return (
    status === "capture_busy" ||
    status === "processing" ||
    status === "capture_pending" ||
    code === "CAPTURE_BUSY" ||
    code === "TIP_WINDOW_OPEN" ||
    status.includes("tip_window")
  );
}

export async function processClaimedTripCaptureJob(
  supabase: SupabaseClient,
  job: ClaimedTripCaptureJob,
  args: {
    supabaseUrl: string;
    serviceRoleKey: string;
  },
): Promise<{ outcome: string }> {
  const { data: trip, error: tripErr } = await supabase
    .from("trips")
    .select(
      "id, status, driver_id, stacked_trip_id, provider_order_id, payment_intent_id, payment_session_id, payment_status, tip_window_status, tip_window_expires_at, tip_window_closed_at",
    )
    .eq("id", job.tripId)
    .maybeSingle();

  if (tripErr || !trip) {
    // Preflight failure — uses claim_count budget, not capture_attempt_count.
    if (job.claimCount >= TRIP_CAPTURE_JOB_MAX_CLAIMS_WITHOUT_CAPTURE) {
      return await markFailedTerminalAndAlert(supabase, job, {
        lastError: tripErr?.message ?? "trip_missing",
        lastFinalizeStatus: "trip_missing",
      });
    }
    await finishJobAttempt(supabase, job, {
      status: "queued",
      nextAttemptAt: new Date(Date.now() + backoffMsForCaptureAttempt(job.claimCount))
        .toISOString(),
      lastError: tripErr?.message ?? "trip_missing",
      lastFinalizeStatus: "trip_missing",
    });
    return { outcome: "trip_missing" };
  }

  if (String(trip.status ?? "").toLowerCase() !== "completed") {
    await finishJobAttempt(supabase, job, {
      status: "queued",
      nextAttemptAt: new Date(Date.now() + BUSY_BACKOFF_MS).toISOString(),
      lastError: "trip_not_completed",
      lastFinalizeStatus: "trip_not_completed",
    });
    return { outcome: "trip_not_completed" };
  }

  const tipWindowStatus = String(trip.tip_window_status ?? "").toLowerCase();
  const tipWindowClosed = trip.tip_window_closed_at != null;
  if (tipWindowStatus === "open" && !tipWindowClosed) {
    const expiresAt = trip.tip_window_expires_at
      ? new Date(String(trip.tip_window_expires_at)).getTime()
      : Date.now() + 60_000;
    await finishJobAttempt(supabase, job, {
      status: "queued",
      nextAttemptAt: new Date(Math.max(Date.now() + BUSY_BACKOFF_MS, expiresAt))
        .toISOString(),
      lastError: "tip_window_open",
      lastFinalizeStatus: "tip_window_open",
    });
    return { outcome: "tip_window_open" };
  }

  const providerOrderId = tripProviderOrderId(trip as Record<string, unknown>);
  const hasStackedTrip = Boolean(trip.stacked_trip_id);
  const driverId = typeof trip.driver_id === "string" ? trip.driver_id : null;

  // Capture budget starts here — claim/reclaim before this line does not burn it.
  let captureAttemptCount = job.captureAttemptCount;
  try {
    captureAttemptCount = await bumpCaptureAttempt(supabase, job);
  } catch (bumpErr) {
    console.error("[trip-capture-job] bump capture attempt failed", {
      trip_id: job.tripId,
      error: bumpErr instanceof Error ? bumpErr.message : String(bumpErr),
    });
    await finishJobAttempt(supabase, job, {
      status: "queued",
      nextAttemptAt: new Date(Date.now() + BUSY_BACKOFF_MS).toISOString(),
      lastError: "bump_capture_attempt_failed",
      lastFinalizeStatus: "bump_failed",
    });
    return { outcome: "bump_failed" };
  }

  console.log("[PAYMENT_AUDIT]", JSON.stringify({
    stage: "trip_capture_job_trigger",
    trip_id: job.tripId,
    job_id: job.jobId,
    claim_count: job.claimCount,
    capture_attempt_count: captureAttemptCount,
    provider_order_id: providerOrderId,
    source: job.source,
  }));

  let finalizeResult: {
    ok: boolean;
    error?: string;
    body?: Record<string, unknown>;
  };
  try {
    finalizeResult = await invokeFinalizeTripCapture({
      supabaseUrl: args.supabaseUrl,
      serviceRoleKey: args.serviceRoleKey,
      tripId: job.tripId,
      tipPence: job.tipPence,
      source: "trip-capture-job",
    });
  } catch (err) {
    finalizeResult = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const bodyStatus = String(finalizeResult.body?.status ?? "").toLowerCase();
  // invokeFinalizeTripCapture treats capture_busy / processing as ok — still retry.
  if (isRetryableBusy(finalizeResult.body)) {
    await finishJobAttempt(supabase, job, {
      status: "queued",
      nextAttemptAt: new Date(Date.now() + BUSY_BACKOFF_MS).toISOString(),
      lastError: finalizeResult.error ?? bodyStatus,
      lastFinalizeStatus: bodyStatus || "busy",
    });
    return { outcome: "busy_reschedule" };
  }

  const applied = await applyCompleteTripCaptureOutcome(supabase, {
    tripId: job.tripId,
    driverId,
    providerOrderId,
    hasStackedTrip,
    finalizeResult,
  });

  // Tip outcomes are never fare shortfall. Payment columns already tip-classified;
  // terminal alert (if exhausted) must not reclassify them.
  if (
    applied.applied === "tip_outcome" ||
    isTipCaptureOutcomeStatus(bodyStatus)
  ) {
    if (captureAttemptCount >= TRIP_CAPTURE_JOB_MAX_CAPTURE_ATTEMPTS) {
      return await markFailedTerminalAndAlert(supabase, job, {
        lastError: finalizeResult.error ?? (bodyStatus || "tip_capture_failed"),
        lastFinalizeStatus: bodyStatus || "tip_capture_failed",
      });
    }
    await finishJobAttempt(supabase, job, {
      status: "queued",
      nextAttemptAt: new Date(
        Date.now() + backoffMsForCaptureAttempt(captureAttemptCount),
      ).toISOString(),
      lastError: finalizeResult.error ?? (bodyStatus || "tip_outcome"),
      lastFinalizeStatus: bodyStatus || "tip_outcome",
    });
    return { outcome: "tip_outcome_retry" };
  }

  // Fare shortfall / recovery / incremental only — never tip_* statuses.
  if (
    isFareDurableRecoveryStatus(bodyStatus) ||
    applied.applied === "durable_recovery"
  ) {
    return await markFailedTerminalAndAlert(supabase, job, {
      lastError: finalizeResult.error ?? (bodyStatus || "durable_recovery"),
      lastFinalizeStatus: bodyStatus || "durable_recovery",
    });
  }

  if (finalizeResult.ok && applied.applied === "ok") {
    await finishJobAttempt(supabase, job, {
      status: "done",
      lastFinalizeStatus: bodyStatus || "ok",
    });
    return { outcome: "done" };
  }

  if (captureAttemptCount >= TRIP_CAPTURE_JOB_MAX_CAPTURE_ATTEMPTS) {
    return await markFailedTerminalAndAlert(supabase, job, {
      lastError: finalizeResult.error ?? "max_capture_attempts",
      lastFinalizeStatus: bodyStatus || applied.applied || "capture_failed",
    });
  }

  await finishJobAttempt(supabase, job, {
    status: "queued",
    nextAttemptAt: new Date(
      Date.now() + backoffMsForCaptureAttempt(captureAttemptCount),
    ).toISOString(),
    lastError: finalizeResult.error ?? "capture_failed",
    lastFinalizeStatus: bodyStatus || "capture_failed",
  });
  return { outcome: "retry_queued" };
}

export async function processTripCaptureJobByTripId(
  supabase: SupabaseClient,
  tripId: string,
  args: {
    supabaseUrl: string;
    serviceRoleKey: string;
  },
): Promise<{ outcome: string }> {
  const claimed = await claimTripCaptureJobByTripId(supabase, tripId);
  if (!claimed) {
    return { outcome: "not_claimed" };
  }
  return await processClaimedTripCaptureJob(supabase, claimed, args);
}

export async function listTripCaptureJobsAlertPending(
  supabase: SupabaseClient,
  limit = 20,
): Promise<PendingAlertJob[]> {
  const { data, error } = await supabase.rpc("list_trip_capture_jobs_alert_pending", {
    p_limit: limit,
  });
  if (error) {
    console.error("[trip-capture-job] list alert pending failed", error.message);
    return [];
  }
  const rows = Array.isArray(data) ? data : [];
  return rows.map((row) => {
    const r = asRecord(row) ?? {};
    return {
      jobId: String(r.job_id ?? ""),
      tripId: String(r.trip_id ?? ""),
      lastError: r.last_error != null ? String(r.last_error) : null,
      lastFinalizeStatus: r.last_finalize_status != null
        ? String(r.last_finalize_status)
        : null,
      adminAlertKey: r.admin_alert_key != null ? String(r.admin_alert_key) : null,
      captureAttemptCount: Math.max(
        0,
        Math.floor(Number(r.capture_attempt_count ?? 0) || 0),
      ),
      claimCount: Math.max(0, Math.floor(Number(r.claim_count ?? 0) || 0)),
      source: String(r.source ?? "trip-capture-job"),
    };
  }).filter((j) => j.jobId && j.tripId);
}

/** Retry durable admin alerts for failed_terminal rows still pending. */
export async function processPendingTripCaptureAdminAlerts(
  supabase: SupabaseClient,
  limit = 20,
): Promise<Array<{ trip_id: string; delivered: boolean; reason?: string }>> {
  const pending = await listTripCaptureJobsAlertPending(supabase, limit);
  const results: Array<{ trip_id: string; delivered: boolean; reason?: string }> = [];
  for (const job of pending) {
    const one = await deliverTripCaptureFailedTerminalAlert(supabase, {
      jobId: job.jobId,
      tripId: job.tripId,
      lastError: job.lastError,
      lastFinalizeStatus: job.lastFinalizeStatus,
      alertKey: job.adminAlertKey,
      captureAttemptCount: job.captureAttemptCount,
      claimCount: job.claimCount,
    });
    results.push({
      trip_id: job.tripId,
      delivered: one.delivered,
      reason: one.reason,
    });
  }
  return results;
}
