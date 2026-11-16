/**
 * Lock: scheduled journey future-compliance must stay wired into accept,
 * admin assign, release, reconcile, and Edge entry points.
 */
import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, import.meta.url));
}

Deno.test("migration defines journey-horizon SSOT + release + reconcile", async () => {
  const sql = await read(
    "../../migrations/20270224120000_scheduled_journey_compliance_future_eligibility.sql",
  );
  assertStringIncludes(sql, "check_driver_documents_valid_through");
  assertStringIncludes(sql, "assert_driver_scheduled_journey_compliance");
  assertStringIncludes(sql, "driver_eligible_for_scheduled_journey");
  assertStringIncludes(sql, "release_scheduled_assignment_for_compliance");
  assertStringIncludes(sql, "release_ineligible_scheduled_assignments_for_driver");
  assertStringIncludes(sql, "reconcile_scheduled_journey_compliance");
  assertStringIncludes(sql, "Europe/London");
  assertStringIncludes(sql, "trip_schedule_estimated_end");
  assertStringIncludes(sql, "driver_eligible_for_scheduled_journey(v_driver_id, p_trip_id)");
  assertStringIncludes(sql, "driver_eligible_for_scheduled_journey(p_driver_id, p_trip_id)");
  assertStringIncludes(sql, "trg_release_scheduled_on_driver_account_change");
  // Must not invent a second eligibility engine name.
  assert(!sql.includes("create_competing_eligibility"));
});

Deno.test("Edge SSOT + gate + notification type exist", async () => {
  const ssot = await read("../../functions/_shared/scheduledJourneyComplianceSSOT.ts");
  const gate = await read("../../functions/_shared/scheduledJourneyComplianceGate.ts");
  const notif = await read("../../functions/send-driver-notification/index.ts");
  assertStringIncludes(ssot, "evaluateScheduledJourneyCompliance");
  assertStringIncludes(ssot, "DOCUMENTS_EXPIRE_BEFORE_JOURNEY_END");
  assertStringIncludes(ssot, "temporaryOfflineReleasesConfirmedBooking");
  assertStringIncludes(ssot, "SCHEDULED_COMPLIANCE_RELEASE_DRIVER_MESSAGE");
  assertStringIncludes(gate, "assertScheduledJourneyComplianceForDriverTrip");
  assertStringIncludes(gate, "releaseConfirmedScheduledForCompliance");
  assertStringIncludes(gate, "reconcileConfirmedScheduledJourneyCompliance");
  assertStringIncludes(notif, "SCHEDULED_COMPLIANCE_RELEASE");
});

Deno.test("accept / admin / JIT / dispatch wire journey compliance", async () => {
  const accept = await read("../../functions/scheduled-ride-action/index.ts");
  const admin = await read("../../functions/admin-scheduled-ride-action/index.ts");
  const exclusive = await read("../../functions/_shared/scheduledActivationExclusiveRescue.ts");
  const dispatch = await read("../../functions/scheduled-dispatch/index.ts");
  assertStringIncludes(accept, "assertScheduledJourneyComplianceForDriverTrip");
  assertStringIncludes(accept, "DOCUMENTS_EXPIRE_BEFORE_JOURNEY_END");
  assertStringIncludes(admin, "assertScheduledJourneyComplianceForDriverTrip");
  assertStringIncludes(exclusive, "documents_expire_before_journey_end");
  assertStringIncludes(dispatch, "reconcile_scheduled_journey_compliance");
  assertStringIncludes(dispatch, "SCHEDULED_JOURNEY_COMPLIANCE_RECONCILE");
});
