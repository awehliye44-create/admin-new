/**
 * Lock — Lovable Detected Issues remediation (auth / RLS / tip trust).
 *
 * Run:
 *   deno test --allow-read supabase/tests/_shared/lovableSecurityRemediationLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveTrustedCaptureTipPence } from "../../functions/_shared/resolveTrustedCaptureTipPence.ts";

async function readRel(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, import.meta.url));
}

Deno.test("finalize-trip-and-capture requires cron/service-role auth", async () => {
  const src = await readRel("../../functions/finalize-trip-and-capture/index.ts");
  assertStringIncludes(src, "assertCronOrServiceRoleAuth");
  assertStringIncludes(src, "if (!auth.ok) return auth.response");
  assertStringIncludes(src, "resolveTrustedCaptureTipPence");
});

Deno.test("trusted tip ignores body inflation except tip-submit source", () => {
  const trip = { tip_amount_pence: 100, tip_pence: 100 };
  assertEquals(
    resolveTrustedCaptureTipPence({
      source: "submit_customer_trip_tip",
      bodyTipPence: 100,
      trip,
    }),
    100,
  );
  assertEquals(
    resolveTrustedCaptureTipPence({
      source: "capture_expired_tip_windows",
      bodyTipPence: 5000,
      trip: { tip_amount_pence: 0, tip_pence: 0 },
    }),
    0,
  );
  assertEquals(
    resolveTrustedCaptureTipPence({
      source: "stop-workflow:complete_trip",
      bodyTipPence: 9999,
      trip: { tip_amount_pence: 0 },
    }),
    0,
  );
  assertEquals(
    resolveTrustedCaptureTipPence({
      source: "stop-workflow:complete_trip",
      bodyTipPence: 9999,
      trip: { tip_amount_pence: 250 },
    }),
    250,
  );
});

Deno.test("lovable publish endpoints requireAdmin", async () => {
  const admin = await readRel("../../functions/admin-lovable-publish/index.ts");
  const apps = await readRel("../../functions/lovable-app-publish/index.ts");
  assertStringIncludes(admin, "requireAdmin");
  assertStringIncludes(apps, "requireAdmin");
  assertStringIncludes(admin, "if (!gate.ok) return gate.response");
  assertStringIncludes(apps, "if (!gate.ok) return gate.response");
});

Deno.test("corporate_schedule_holds RLS lockdown migration present", async () => {
  const mig = await Deno.readTextFile(
    new URL(
      "../../migrations/20261112230000_corporate_holds_rls_and_search_path.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(mig, "corporate_schedule_holds ENABLE ROW LEVEL SECURITY");
  assertStringIncludes(mig, "FORCE ROW LEVEL SECURITY");
  assertStringIncludes(mig, "REVOKE ALL ON TABLE public.corporate_schedule_holds FROM anon");
  assertStringIncludes(mig, "protect_trip_invoice_email_columns");
  assertStringIncludes(mig, "SET search_path = pg_catalog, public");
});
