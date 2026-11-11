/**
 * Lock: Complete Trip defers Revolut capture behind a durable trip_capture_jobs row.
 * Safeguards: failed_terminal always alerts (retryable); claim_count ≠ capture budget.
 *
 * Run: deno test --allow-read supabase/tests/_shared/tripCaptureJobDeferralLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const stopWorkflowPath = new URL(
  "../../functions/stop-workflow/index.ts",
  import.meta.url,
);
const jobSsotPath = new URL(
  "../../functions/_shared/tripCaptureJobSSOT.ts",
  import.meta.url,
);
const outcomePath = new URL(
  "../../functions/_shared/applyCompleteTripCaptureOutcome.ts",
  import.meta.url,
);
const processorPath = new URL(
  "../../functions/process-trip-capture-jobs/index.ts",
  import.meta.url,
);
const migrationPath = new URL(
  "../../migrations/20270111120000_trip_capture_jobs.sql",
  import.meta.url,
);

Deno.test("migration separates claim_count from capture_attempt_count + alert pending", async () => {
  const sql = await Deno.readTextFile(migrationPath);
  assertStringIncludes(sql, "CREATE TABLE IF NOT EXISTS public.trip_capture_jobs");
  assertStringIncludes(sql, "CONSTRAINT trip_capture_jobs_trip_id_unique UNIQUE (trip_id)");
  assertStringIncludes(sql, "claim_count integer NOT NULL DEFAULT 0");
  assertStringIncludes(sql, "capture_attempt_count integer NOT NULL DEFAULT 0");
  assertStringIncludes(sql, "admin_alert_pending boolean NOT NULL DEFAULT false");
  assertStringIncludes(sql, "admin_alerted_at timestamptz");
  assertStringIncludes(sql, "admin_alert_key text");
  assertStringIncludes(sql, "idx_trip_capture_jobs_alert_pending");
  assertStringIncludes(sql, "claim_trip_capture_jobs");
  assertStringIncludes(sql, "claim_trip_capture_job_by_trip_id");
  assertStringIncludes(sql, "bump_trip_capture_attempt");
  assertStringIncludes(sql, "mark_trip_capture_admin_alert_delivered");
  assertStringIncludes(sql, "list_trip_capture_jobs_alert_pending");
  assertStringIncludes(sql, "update_trip_capture_job_after_attempt");
  // Claim must bump claim_count only — never capture_attempt_count.
  const claimFnStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.claim_trip_capture_jobs");
  const claimFnEnd = sql.indexOf(
    "CREATE OR REPLACE FUNCTION public.claim_trip_capture_job_by_trip_id",
  );
  const claimFn = sql.slice(claimFnStart, claimFnEnd);
  assertStringIncludes(claimFn, "claim_count = j.claim_count + 1");
  assertEquals(claimFn.includes("capture_attempt_count = j.capture_attempt_count + 1"), false);
  // failed_terminal always stamps admin_alert_pending.
  const updateFn = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.update_trip_capture_job_after_attempt"),
  );
  assertStringIncludes(updateFn, "WHEN p_status = 'failed_terminal' THEN true");
});

Deno.test("crash reclaim does not burn capture budget; bump only before finalize", async () => {
  const src = await Deno.readTextFile(jobSsotPath);
  assertStringIncludes(src, "claimCount");
  assertStringIncludes(src, "captureAttemptCount");
  assertStringIncludes(src, "bump_trip_capture_attempt");
  assertStringIncludes(src, "bumpCaptureAttempt");
  assertStringIncludes(src, "TRIP_CAPTURE_JOB_MAX_CAPTURE_ATTEMPTS");
  assertStringIncludes(src, "TRIP_CAPTURE_JOB_MAX_CLAIMS_WITHOUT_CAPTURE");
  assertStringIncludes(src, "TRIP_CAPTURE_JOB_CLAIM_TTL_SECONDS = 120");
  // Capture budget bump must happen after tip-window / trip-missing preflight.
  const processStart = src.indexOf("export async function processClaimedTripCaptureJob");
  const processFn = src.slice(processStart);
  const tipWindowReturn = processFn.indexOf('return { outcome: "tip_window_open" }');
  const bumpCall = processFn.indexOf("await bumpCaptureAttempt");
  const finalizeCall = processFn.indexOf("invokeFinalizeTripCapture");
  assertEquals(tipWindowReturn > 0 && bumpCall > tipWindowReturn, true);
  assertEquals(finalizeCall > bumpCall, true);
  // Retry limit uses capture_attempt_count, not claim_count.
  assertStringIncludes(
    processFn,
    "captureAttemptCount >= TRIP_CAPTURE_JOB_MAX_CAPTURE_ATTEMPTS",
  );
  assertStringIncludes(
    processFn,
    "job.claimCount >= TRIP_CAPTURE_JOB_MAX_CLAIMS_WITHOUT_CAPTURE",
  );
});

Deno.test("every failed_terminal path alerts with dedupe key; independent of recordTripCaptureFailure", async () => {
  const src = await Deno.readTextFile(jobSsotPath);
  assertStringIncludes(src, "markFailedTerminalAndAlert");
  assertStringIncludes(src, "deliverTripCaptureFailedTerminalAlert");
  assertStringIncludes(src, "sendAdminNotification");
  assertStringIncludes(src, "TRIP_CAPTURE_FAILED_TERMINAL");
  assertStringIncludes(src, "buildTripCaptureFailedTerminalAlertKey");
  assertStringIncludes(src, "trip_capture_failed_terminal:");
  assertStringIncludes(src, "mark_trip_capture_admin_alert_delivered");
  assertStringIncludes(src, "admin_alert_pending");
  // Delivery requires durable in-app OR cooldown skip — not email alone.
  assertStringIncludes(src, "result.skipped === true || result.in_app === true");
  // Terminal helper used for trip_missing, shortfall/recovery, and max capture attempts.
  assertEquals(src.includes('lastFinalizeStatus: "trip_missing"'), true);
  assertEquals(src.includes('lastFinalizeStatus: bodyStatus || "durable_recovery"'), true);
  assertEquals(src.includes("max_capture_attempts"), true);
  // Tip terminal uses tip_capture_failed — not durable_recovery / payment_shortfall.
  assertStringIncludes(src, "tip_capture_failed");
  assertStringIncludes(src, "isTipCaptureOutcomeStatus");
  assertStringIncludes(src, "isFareDurableRecoveryStatus");
  // Alert path must not require recordTripCaptureFailure.
  assertEquals(src.includes("recordTripCaptureFailure"), false);
  const markFn = src.slice(src.indexOf("async function markFailedTerminalAndAlert"));
  assertStringIncludes(markFn, 'status: "failed_terminal"');
  assertStringIncludes(markFn, "deliverTripCaptureFailedTerminalAlert");
  // Stamp pending before / with terminal; delivery after.
  assertStringIncludes(markFn, "adminAlertKey: alertKey");
});

Deno.test("alert pending is retryable via cron processor", async () => {
  const src = await Deno.readTextFile(jobSsotPath);
  assertStringIncludes(src, "processPendingTripCaptureAdminAlerts");
  assertStringIncludes(src, "listTripCaptureJobsAlertPending");
  assertStringIncludes(src, "list_trip_capture_jobs_alert_pending");
  const processor = await Deno.readTextFile(processorPath);
  assertStringIncludes(processor, "processPendingTripCaptureAdminAlerts");
  assertStringIncludes(processor, "alert_retries");
});

Deno.test("job SSOT enqueues idempotently and processes via existing finalize invoke", async () => {
  const src = await Deno.readTextFile(jobSsotPath);
  assertStringIncludes(src, "enqueueTripCaptureJob");
  assertStringIncludes(src, 'status: "queued"');
  assertStringIncludes(src, "23505");
  assertStringIncludes(src, "invokeFinalizeTripCapture");
  assertStringIncludes(src, 'source: "trip-capture-job"');
  assertStringIncludes(src, "applyCompleteTripCaptureOutcome");
  assertStringIncludes(src, "stampTripCaptureRequested");
  assertStringIncludes(src, 'payment_status: "capture_requested"');
  assertStringIncludes(src, "busy_reschedule");
  assertStringIncludes(src, "isRetryableBusy");
});

Deno.test("outcome helper preserves shortfall / capture_failed / stacked recovery", async () => {
  const src = await Deno.readTextFile(outcomePath);
  assertStringIncludes(src, "recordTripCaptureFailure");
  assertStringIncludes(src, "handleQueuedTripAfterPaymentFailure");
  assertStringIncludes(src, "payment_shortfall");
  assertStringIncludes(src, "incremental_authorisation_pending");
  assertStringIncludes(src, "capture_failed");
});

Deno.test("processor is cron/service-role only and reuses job SSOT", async () => {
  const src = await Deno.readTextFile(processorPath);
  assertStringIncludes(src, "assertCronOrServiceRoleAuth");
  assertStringIncludes(src, "claimTripCaptureJobs");
  assertStringIncludes(src, "processTripCaptureJobByTripId");
  assertStringIncludes(src, "processClaimedTripCaptureJob");
  assertStringIncludes(src, "processPendingTripCaptureAdminAlerts");
});

Deno.test("stop-workflow tip-window path still skips enqueue and still posts TEN", async () => {
  const src = await Deno.readTextFile(stopWorkflowPath);
  const completeIdx = src.lastIndexOf("case 'complete_trip'");
  const complete = src.slice(completeIdx);
  assertStringIncludes(complete, "deferCaptureForTipWindow");
  assertStringIncludes(complete, "tip_window_capture_deferred");
  assertStringIncludes(complete, "postTripEarningNetCanonical");
  const tipDeferredIdx = complete.indexOf("tipWindowDeferred = true");
  const enqueueIdx = complete.indexOf("enqueueTripCaptureJob");
  assertEquals(tipDeferredIdx > 0 && enqueueIdx > tipDeferredIdx, true);
  assertStringIncludes(complete, "if (!tipWindowDeferred)");
});

Deno.test("stop-workflow never drops capture: enqueue or inline fail-safe", async () => {
  const src = await Deno.readTextFile(stopWorkflowPath);
  const complete = src.slice(src.lastIndexOf("case 'complete_trip'"));
  assertStringIncludes(complete, "enqueueTripCaptureJob");
  assertStringIncludes(complete, "enqueue_fallback");
  assertStringIncludes(complete, "invokeFinalizeTripCapture");
  assertStringIncludes(complete, "applyCompleteTripCaptureOutcome");
  assertStringIncludes(complete, "complete_trip_capture_job");
  assertStringIncludes(complete, "processTripCaptureJobByTripId");
});
