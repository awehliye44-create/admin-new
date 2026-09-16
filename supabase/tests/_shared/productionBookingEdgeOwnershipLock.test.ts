/**
 * Production booking Edge is admin-new on thazislrdkjpvvghtvzo.
 * The Customer repo supabase/functions copy is stale and must not be deployed.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";

const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));

Deno.test("admin-new create-trip-after-payment is the production booking writer", async () => {
  const ctap = await Deno.readTextFile(
    join(REPO_ROOT, "supabase/functions/create-trip-after-payment/index.ts"),
  );
  const booking = await Deno.readTextFile(
    join(REPO_ROOT, "supabase/functions/_shared/bookingSSOT.ts"),
  );
  assert(ctap.includes("skipPlatformPreauth"));
  assert(ctap.includes("tripInsertFieldsFromFinancialModelSnapshot") || booking.includes("tripInsertFieldsFromFinancialModelSnapshot"));
  assert(booking.includes("invokeBookingCommitAfterPayment"));
  assert(booking.includes("create-trip-after-payment"));
  assert(!booking.includes("create-ride"));
  const createRide = await Deno.readTextFile(
    join(REPO_ROOT, "supabase/functions/create-ride/index.ts"),
  );
  const createTripRequest = await Deno.readTextFile(
    join(REPO_ROOT, "supabase/functions/create-trip-request/index.ts"),
  );
  const createTrip = await Deno.readTextFile(
    join(REPO_ROOT, "supabase/functions/create-trip/index.ts"),
  );
  assert(createRide.includes("USE_CREATE_TRIP_AFTER_PAYMENT"));
  assert(createRide.includes("410"));
  assert(createTripRequest.includes("USE_CREATE_TRIP_AFTER_PAYMENT"));
  assert(createTripRequest.includes("410"));
  assert(createTrip.includes("USE_CREATE_TRIP_AFTER_PAYMENT"));
  assert(createTrip.includes("410"));
});
