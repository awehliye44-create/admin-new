/**
 * Corporate + booking-snapshot pickup-note persistence locks.
 * Canonical field: trips.special_instructions (same as Customer).
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";
import {
  buildCanonicalBookingSnapshot,
  validateCanonicalBookingSnapshot,
} from "../../functions/_shared/bookingSnapshotSSOT.ts";

const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));

Deno.test("corporate book wires Notes for Driver → special_instructions", async () => {
  const src = await Deno.readTextFile(
    join(REPO_ROOT, "supabase/functions/create-corporate-book/index.ts"),
  );
  assertStringIncludes(src, "special_instructions");
  assertStringIncludes(src, "notes_for_driver");
  assertStringIncludes(src, "specialInstructions");
  // Never invent a corporate-only notes column.
  assertEquals(/corporate_notes|driver_notes\b/.test(src), false);
});

Deno.test("canonical booking snapshot preserves special_instructions", () => {
  const snap = buildCanonicalBookingSnapshot({
    clientActionId: "11111111-1111-4111-8111-111111111111",
    serviceAreaId: "22222222-2222-4222-8222-222222222222",
    vehicleTypeId: "33333333-3333-4333-8333-333333333333",
    pickup: { address: "Pickup", lat: 52.04, lng: -0.76 },
    dropoff: { address: "Drop", lat: 52.05, lng: -0.75 },
    when: "NOW",
    passengerName: "Alex",
    passengerPhone: "+441234567890",
    estimatedFareMajor: 12.5,
    finalEstimatedFarePence: 1250,
    grossFarePence: 1250,
    currencyCode: "GBP",
    paymentMethod: "card",
    bookingSource: "corporate_portal",
    specialInstructions: "Please call when outside.",
  });
  assertEquals(snap.special_instructions, "Please call when outside.");

  const validated = validateCanonicalBookingSnapshot(snap);
  assertEquals(validated.ok, true);
  if (validated.ok) {
    assertEquals(validated.snapshot.special_instructions, "Please call when outside.");
  }
});

Deno.test("empty special_instructions is omitted from canonical snapshot", () => {
  const snap = buildCanonicalBookingSnapshot({
    clientActionId: "11111111-1111-4111-8111-111111111111",
    serviceAreaId: "22222222-2222-4222-8222-222222222222",
    vehicleTypeId: "33333333-3333-4333-8333-333333333333",
    pickup: { address: "Pickup", lat: 52.04, lng: -0.76 },
    dropoff: { address: "Drop", lat: 52.05, lng: -0.75 },
    when: "NOW",
    passengerName: "Alex",
    passengerPhone: "+441234567890",
    estimatedFareMajor: 12.5,
    finalEstimatedFarePence: 1250,
    grossFarePence: 1250,
    currencyCode: "GBP",
    paymentMethod: "card",
    specialInstructions: "   ",
  });
  assertEquals(snap.special_instructions, undefined);
});

Deno.test("active-trip snapshot migration exposes special_instructions", async () => {
  const mig = await Deno.readTextFile(
    join(
      REPO_ROOT,
      "supabase/migrations/20261123130000_driver_snapshot_special_instructions.sql",
    ),
  );
  assertStringIncludes(mig, "get_driver_active_trip_snapshot");
  assertStringIncludes(mig, "'special_instructions'");
  assertStringIncludes(mig, "v_trip.special_instructions");
});

Deno.test("finalize_paid_booking still reads draft special_instructions", async () => {
  const mig = await Deno.readTextFile(
    join(
      REPO_ROOT,
      "supabase/migrations/20260919120000_p0_payment_authorisation_amount_gate.sql",
    ),
  );
  assertStringIncludes(mig, "special_instructions");
  assertStringIncludes(mig, "v_draft->>'special_instructions'");
});
