/**
 * A8B28F-B2R — draft path smoke tests (re-exports live SSOT).
 * Canonical suite: supabase/functions/_shared/revolutUkDriverCounterpartyPayload.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import {
  buildUkDriverRevolutCounterpartyBody,
  detectUkDriverCounterpartyKind,
} from "./revolutUkDriverCounterpartyPayload.draft.ts";

Deno.test("draft re-export: ONECAB Limited → business company_name", () => {
  assertEquals(detectUkDriverCounterpartyKind("ONECAB Limited"), "business");
  const body = buildUkDriverRevolutCounterpartyBody({
    accountHolderName: "ONECAB Limited",
    destinationIdentifier: "04000379313778",
  });
  assertEquals(body.company_name, "ONECAB Limited");
  assertEquals("profile_type" in body, false);
});
