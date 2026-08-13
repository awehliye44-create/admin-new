/**
 * Slice 1 deploy-bundle lock — rank SSOT must be a static _shared import
 * (dynamic ../../../shared/... is not uploaded by supabase functions deploy).
 *
 * Run: deno test --allow-read --no-check shared/revolutWebhookSlice1BundleLock.deno.test.ts
 */
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dirname, fromFileUrl, join } from "https://deno.land/std@0.224.0/path/mod.ts";

const REPO_ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");

Deno.test("revolut-webhook statically imports _shared revolutProviderStateRankSSOT", () => {
  const src = Deno.readTextFileSync(
    join(REPO_ROOT, "supabase/functions/revolut-webhook/index.ts"),
  );
  assert(
    src.includes('from "../_shared/revolutProviderStateRankSSOT.ts"'),
    "missing static _shared rank SSOT import",
  );
  assert(
    !src.includes("../../../shared/revolutProviderStateRankSSOT.ts"),
    "dynamic shared/ rank import must not return — it is not bundled on deploy",
  );
  assert(src.includes("never_capture"), "missing never_capture orphan guard");
  assert(
    src.includes("CUSTOMER_ALREADY_HAS_ACTIVE_TRIP"),
    "missing CUSTOMER_ALREADY_HAS_ACTIVE_TRIP orphan path",
  );
});

Deno.test("capture guards block never_capture sessions", () => {
  const revolut = Deno.readTextFileSync(
    join(REPO_ROOT, "supabase/functions/revolut-capture-order/index.ts"),
  );
  const admin = Deno.readTextFileSync(
    join(REPO_ROOT, "supabase/functions/admin-capture-trip-payment/index.ts"),
  );
  for (const [name, src] of [
    ["revolut-capture-order", revolut],
    ["admin-capture-trip-payment", admin],
  ] as const) {
    assert(src.includes("never_capture"), `${name}: missing never_capture`);
    assert(
      src.includes("CAPTURE_BLOCKED_NEVER_CAPTURE"),
      `${name}: missing CAPTURE_BLOCKED_NEVER_CAPTURE`,
    );
  }
});

Deno.test("finalize-paid-booking-session surfaces CUSTOMER_ALREADY_HAS_ACTIVE_TRIP", () => {
  const src = Deno.readTextFileSync(
    join(REPO_ROOT, "supabase/functions/finalize-paid-booking-session/index.ts"),
  );
  assert(src.includes("CUSTOMER_ALREADY_HAS_ACTIVE_TRIP"));
  assert(src.includes("existing_trip_id"));
});

Deno.test("rank SSOT module exists under functions/_shared", () => {
  const src = Deno.readTextFileSync(
    join(REPO_ROOT, "supabase/functions/_shared/revolutProviderStateRankSSOT.ts"),
  );
  assert(src.includes("export function revolutProviderStateRank"));
  assert(src.includes("export function isRevolutProviderStateRegression"));
});
