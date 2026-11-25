/**
 * #92J — Booking payable snapshot must be created on the CTAP request path
 * for all PLATFORM_COLLECTED channels (not waitUntil-only).
 * MK-261125-006: waitUntil enrich aborted → completion snap only, zero fail events.
 */
import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;

Deno.test("#92J CTAP sync booking snapshot after insert (all PC channels)", () => {
  const ctap = Deno.readTextFileSync(
    `${ROOT}supabase/functions/create-trip-after-payment/index.ts`,
  );
  const booking = Deno.readTextFileSync(
    `${ROOT}supabase/functions/create-trip-after-payment/lib/bookingPostCommit.ts`,
  );
  assertStringIncludes(ctap, "persistBookingPayableSnapshotAfterInsert");
  assertStringIncludes(ctap, "!skipPlatformPreauth");
  assertStringIncludes(booking, "export async function persistBookingPayableSnapshotAfterInsert");
  assertStringIncludes(booking, "export async function persistBookingPayableSnapshot");
  assertStringIncludes(booking, 'source: "booking"');
  assertStringIncludes(booking, "paymentSessionId");
  // Primary write is sync — not solely behind waitUntil enrich.
  const syncIdx = ctap.indexOf("persistBookingPayableSnapshotAfterInsert");
  const waitIdx = ctap.indexOf("EdgeRuntime.waitUntil");
  assert(syncIdx > 0 && waitIdx > syncIdx, "booking snap must run before waitUntil");
});

Deno.test("#92J payable_snapshot_persist_failed records without requiring session id", () => {
  const writer = Deno.readTextFileSync(
    `${ROOT}supabase/functions/_shared/writePayableSnapshotOrLogSSOT.ts`,
  );
  assertStringIncludes(writer, "payable_snapshot_persist_failed");
  assertStringIncludes(writer, "tripId: args.tripId");
  // Must not gate the durable event solely on paymentSessionId.
  assert(
    !writer.includes("if (args.paymentSessionId) {\n        await recordPaymentFinancialEvent"),
    "fail event must not require paymentSessionId",
  );
});

Deno.test("#92J/#92K integrity recovery detects missing booking; never fabricates from trip mods", () => {
  const src = Deno.readTextFileSync(
    `${ROOT}supabase/functions/_shared/platformCollectedFinancialIntegrityRecoverySSOT.ts`,
  );
  assertStringIncludes(src, '.eq("source", "booking")');
  assertStringIncludes(src, "pc-integrity-recovery-booking-gap");
  assertStringIncludes(src, "(bookingSnaps ?? 0) === 0");
  assertStringIncludes(src, "resolveBookingTimePayableEvidence");
  assertStringIncludes(src, "payable_snapshot_booking_gap_unrecoverable");
  assertStringIncludes(src, "refused_to_fabricate_from_modified_trip_fares");
  assertStringIncludes(src, "Never read trips.* fares here");
});

Deno.test("#92K sync booking snap skips when booking already present", () => {
  const booking = Deno.readTextFileSync(
    `${ROOT}supabase/functions/create-trip-after-payment/lib/bookingPostCommit.ts`,
  );
  assertStringIncludes(booking, "skipIfBookingExists");
  assertStringIncludes(booking, "payable_snapshot_booking_already_present");
  assertStringIncludes(booking, "skipIfBookingExists: true");
});

Deno.test("#92J admin cancel finalises waiting; RPC migration closes segments", () => {
  const admin = Deno.readTextFileSync(
    `${ROOT}supabase/functions/admin-trip-actions/index.ts`,
  );
  assertStringIncludes(admin, "finalizeWaitingSegmentsAtTerminal");
  assertStringIncludes(admin, "waiting segment finalize failed");
  const mig = Deno.readTextFileSync(
    `${ROOT}supabase/migrations/20270301150000_terminal_cancel_close_waiting_segments_92j.sql`,
  );
  assertStringIncludes(mig, "trip_waiting_segments");
  assertStringIncludes(mig, "ended_at IS NULL");
  assertStringIncludes(mig, "waiting_segments_closed");
  assertStringIncludes(mig, "already_terminal");
});
