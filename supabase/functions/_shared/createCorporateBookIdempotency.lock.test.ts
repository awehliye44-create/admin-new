import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";

const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));
const SRC = await Deno.readTextFile(
  join(REPO_ROOT, "supabase/functions/create-corporate-book/index.ts"),
);

Deno.test("requires client_action_id and reconciles before create", () => {
  assert(SRC.includes("CLIENT_ACTION_ID_REQUIRED"));
  assert(SRC.includes('loadPaymentSession(admin, { clientActionId })'));
  assert(SRC.includes("idempotent: true"));
  assert(SRC.includes("reconcile_only"));
});

Deno.test("never trusts client fare as authority", () => {
  assert(SRC.includes("calculate-fare"));
  assert(SRC.includes("FARE_MISMATCH") || SRC.includes("server fare"));
  assert(!SRC.includes("estimated_fare_pence: Number(body.estimated_fare"));
  assert(SRC.includes("FARE_COORDINATES_REQUIRED"));
});

Deno.test("does not use legacy trip-first payment Edge", () => {
  // Strip comments before scanning for the forbidden function name.
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert(!code.includes("create-payment-intent"));
  assert(code.includes("createRevolutPreauthResponse"));
  assert(code.includes("tripId: null"));
});

Deno.test("schedule overlap checked on scheduled path", () => {
  assert(SRC.includes("findCorporateScheduleOverlap"));
  assert(SRC.includes("SCHEDULE_OVERLAP"));
});

Deno.test("one key maps to session + order + trip fields in reconcile response", () => {
  assert(SRC.includes("payment_session_id"));
  assert(SRC.includes("provider_order_id"));
  assert(SRC.includes("trip_id"));
  assert(SRC.includes("client_action_id"));
});

Deno.test("corporateScheduleOverlapSSOT present for atomic create", async () => {
  const ssot = await Deno.readTextFile(
    join(REPO_ROOT, "supabase/functions/_shared/corporateScheduleOverlapSSOT.ts"),
  );
  assertEquals(ssot.includes("findCorporateScheduleOverlap"), true);
});
