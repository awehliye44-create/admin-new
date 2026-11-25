/**
 * #92M — Every CTAP success/idempotent PLATFORM_COLLECTED return must ensure
 * a booking payable snapshot. Concurrent races must not silently skip.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("#92M CTAP: every success:true / idempotent path ensures booking snap", async () => {
  const ctap = await Deno.readTextFile(
    new URL("../../functions/create-trip-after-payment/index.ts", import.meta.url),
  );

  assert(ctap.includes("persistBookingPayableSnapshotAfterInsert"));
  assert(ctap.includes("ensureBookingSnapOnIdempotent"));
  assert(ctap.includes("adopted_after_release_claim"));
  assert(
    ctap.includes("booking snap ensure on adopt")
      || ctap.includes("Adopted success must still ensure booking payable snap"),
  );

  // Split on success:true returns and require nearby ensure/persist for PC.
  const markers = [
    "Idempotent — trip already exists",
    "Idempotent — live trip is this booking",
    "Idempotent — trip appeared after live precheck",
    "trips.insert(idempotent)",
    "adopted_after_release_claim",
    "persistBookingPayableSnapshotAfterInsert(supabase, {\n        tripId: trip.id",
  ];
  for (const m of markers) {
    assert(ctap.includes(m) || (m.includes("trip.id") && ctap.includes("tripId: trip.id")), `missing marker: ${m}`);
  }

  // Live-precheck byCa must call ensure (regression: previously returned bare).
  const precheckIdx = ctap.indexOf("Idempotent — trip appeared after live precheck");
  assert(precheckIdx > 0);
  const afterPrecheck = ctap.slice(precheckIdx, precheckIdx + 800);
  assert(
    afterPrecheck.includes("await ensureBookingSnapOnIdempotent"),
    "live-precheck byCa success must ensure booking snap",
  );

  // Adopt path must persist booking snap before returning success.
  const adoptIdx = ctap.indexOf("adopted_after_release_claim");
  assert(adoptIdx > 0);
  const beforeAdopt = ctap.slice(Math.max(0, adoptIdx - 1200), adoptIdx);
  assert(
    beforeAdopt.includes("persistBookingPayableSnapshotAfterInsert"),
    "adopted_after_release_claim must persist booking snap first",
  );

  const ensureCalls = ctap.split("await ensureBookingSnapOnIdempotent(").length - 1;
  assert(ensureCalls >= 5, `expected ≥5 ensureBookingSnapOnIdempotent calls, got ${ensureCalls}`);
});

Deno.test("#92M recovery: booking gap during authorised tip-deferral; no fabricate", async () => {
  const recovery = await Deno.readTextFile(
    new URL(
      "../../functions/_shared/platformCollectedFinancialIntegrityRecoverySSOT.ts",
      import.meta.url,
    ),
  );
  assert(recovery.includes("resolveBookingTimePayableEvidence"));
  assert(recovery.includes("refused_to_fabricate_from_modified_trip_fares"));
  assert(recovery.includes("not_captured_or_authorised"));
  assert(recovery.includes("Completion/recovery snap only after confirmed capture"));
  assert(recovery.includes('"authorized"'));
  assert(recovery.includes("capture_requested"));
});

Deno.test("#92M booking snap writer skips duplicate booking source", async () => {
  const booking = await Deno.readTextFile(
    new URL(
      "../../functions/create-trip-after-payment/lib/bookingPostCommit.ts",
      import.meta.url,
    ),
  );
  assert(booking.includes("skipIfBookingExists"));
  assert(booking.includes("payable_snapshot_booking_already_present"));
  assert(booking.includes('source: "booking"'));
});
