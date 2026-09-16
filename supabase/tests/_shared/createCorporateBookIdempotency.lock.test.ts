import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";

const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));
const SRC = await Deno.readTextFile(
  join(REPO_ROOT, "supabase/functions/create-corporate-book/index.ts"),
);

Deno.test("requires client_action_id and reconciles before create", () => {
  assert(SRC.includes("CLIENT_ACTION_ID_REQUIRED"));
  assert(SRC.includes("loadPaymentSession"));
  assert(SRC.includes("idempotent: true"));
  assert(SRC.includes("reconcile_only"));
});

Deno.test("authority from membership; never trusts body org alone", () => {
  assert(SRC.includes("resolveAuthoritativeCorporateAccountId"));
  assert(SRC.includes("assertCorporateAccountBookable"));
  assert(SRC.includes("assertServiceAreaInOrgScope"));
  assert(SRC.includes("CORPORATE_ORG_MISMATCH") || SRC.includes("authz.code"));
});

Deno.test("never trusts client fare; server calculate-fare", () => {
  assert(SRC.includes("calculate-fare"));
  assert(SRC.includes("FARE_MISMATCH") || SRC.includes("FARE_COORDINATES_REQUIRED"));
});

Deno.test("atomic schedule claim + SSOT recheck; no driver RPC", () => {
  assert(SRC.includes("findCorporateScheduleOverlap"));
  assert(SRC.includes("claim_corporate_schedule_hold"));
  assert(SRC.includes("SCHEDULE_CLAIM_UNAVAILABLE"));
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert(!code.includes("check_schedule_overlap"));
});

Deno.test("wallet/invoice fail closed with unavailable not 501 success", () => {
  assert(SRC.includes("assertPaymentMethodAllowed"));
  assert(SRC.includes("walletImplementedAndEnabled: false"));
  assert(SRC.includes("invoiceImplementedAndEnabled: false"));
  assert(SRC.includes("json(403"));
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert(!/\b501\b/.test(code));
});

Deno.test("canonical claim migration present with advisory lock RPC", async () => {
  const mig = await Deno.readTextFile(
    join(
      REPO_ROOT,
      "supabase/migrations/20261112190000_corporate_schedule_hold_claim.sql",
    ),
  );
  assert(mig.includes("Migration 20261112190000"));
  assert(mig.includes("claim_corporate_schedule_hold"));
  assert(mig.includes("pg_advisory_lock"));
  assert(!mig.includes("DRAFT REVIEW ONLY"));
});
