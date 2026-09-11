/**
 * A8B28F Stage B3 — source locks for admin-verify-driver-payout-destination.
 * Run: deno test --no-check --allow-read supabase/functions/admin-verify-driver-payout-destination/adminVerifyPayoutDestination.b3Lock.test.ts
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/assert_string_includes.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";

const DIR = fromFileUrl(new URL(".", import.meta.url));
const ENTRY = join(DIR, "index.ts");
const HANDLER_B2 = join(DIR, "..", "_shared", "updateDriverPayoutDestinationHandler.ts");
const SSOT = join(DIR, "..", "_shared", "driverPayoutDestinationSSOT.ts");

Deno.test("B3: verify action is hard-forbidden before destination mutation", async () => {
  const src = await Deno.readTextFile(ENTRY);
  assertStringIncludes(src, "ADMIN_MANUAL_VERIFY_FORBIDDEN");
  assertStringIncludes(src, 'action === "verify"');
  assertStringIncludes(src, "status: 403");
  // Forbidden response must appear before service-role create for writes.
  const verifyIdx = src.indexOf('action === "verify"');
  const serviceIdx = src.indexOf('SUPABASE_SERVICE_ROLE_KEY');
  assert(verifyIdx > 0 && serviceIdx > verifyIdx, "verify forbid must precede service-role key use for mutations");
  assert(!/DESTINATION_STATUS\.MANUAL_VERIFIED/.test(src));
  assert(!/verification_status:\s*["']MANUAL_VERIFIED["']/.test(src));
  assert(!/updateFields\.verified_at/.test(src));
  assert(!/updateFields\.verified_by/.test(src));
  assert(!/provider_counterparty_id\s*:/.test(src.split("updateFields")[1] ?? ""));
});

Deno.test("B3: finance ACL + no profiles.role / metadata / body actor trust", async () => {
  const src = await Deno.readTextFile(ENTRY);
  assertStringIncludes(src, "assert_finance_payout_ledger_access");
  assertStringIncludes(src, "auth.getUser");
  assertStringIncludes(src, "Ignore any client-supplied actor/role");
  assert(!/from\(["']profiles["']\)/.test(src));
  assert(!/user_metadata/.test(src));
  assert(!/raw_user_meta_data/.test(src));
  assert(!/body\.(?:role|actor|actor_role|user_id)/.test(src));
  // Coarse user_roles-only admin gate removed in favour of finance assert.
  assert(!/\.from\(["']user_roles["']\)/.test(src));
});

Deno.test("B3: reject/disable remain operational and never invent provider verification", async () => {
  const src = await Deno.readTextFile(ENTRY);
  assertStringIncludes(src, "statusForOperationalAction");
  assertStringIncludes(src, "DESTINATION_STATUS.REJECTED");
  assertStringIncludes(src, "DESTINATION_STATUS.DISABLED");
  assertStringIncludes(src, "invariant_violation");
  assertStringIncludes(src, "admin_${action}");
  assertStringIncludes(src, "manual_verify: false");
  assert(!/createRevolutCounterparty/.test(src));
  assert(!/ensureFreshRevolutBusinessAccessToken/.test(src));
  assert(!/payouts_enabled/.test(src));
  assert(!/driver_wallet_ledger/.test(src));
  assert(!/payment_sessions/.test(src));
});

Deno.test("B3: PII/secret scan on entrypoint", async () => {
  const src = await Deno.readTextFile(ENTRY);
  assert(!/sk_live_|rk_live_/.test(src));
  assert(!/console\.(?:error|warn|log)\([^)]*(?:sort_code|account_number|iban|destination_identifier)/i.test(src));
  assert(!/console\.error\([^)]*error\)/.test(src));
});

Deno.test("B2 linkage handler still never writes MANUAL_VERIFIED", async () => {
  const src = await Deno.readTextFile(HANDLER_B2);
  assert(!/DESTINATION_STATUS\.MANUAL_VERIFIED/.test(src));
  assertStringIncludes(src, "isClientSuccessOutcome");
});

Deno.test("SSOT may still enumerate MANUAL_VERIFIED for historical normalize — not a writer", async () => {
  const src = await Deno.readTextFile(SSOT);
  assert(src.includes("MANUAL_VERIFIED"));
  // SSOT must not UPDATE destinations
  assert(!/\.from\(["']driver_payout_destinations["']\)/.test(src));
});
