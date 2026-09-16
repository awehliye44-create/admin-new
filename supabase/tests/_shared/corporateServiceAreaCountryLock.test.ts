import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CORPORATE_SERVICE_UNAVAILABLE_MESSAGE,
  SERVICE_AREA_COUNTRY_MISMATCH,
  assertServiceAreaCountryMatch,
  normalizeIsoCountryCode,
  serviceAreaCountryMatches,
} from "../../../shared/corporateServiceAreaCountrySSOT.ts";

async function read(pathFromRepoRoot: string): Promise<string> {
  const repoRoot = new URL("../../../", import.meta.url);
  return await Deno.readTextFile(new URL(pathFromRepoRoot, repoRoot));
}

function centralHubPath(rel: string): URL {
  return new URL(`../../../../onecab-central-hub/${rel}`, import.meta.url);
}

const CORPORATE_UNAVAILABLE =
  "ONECAB corporate service is not yet available in your area.";

Deno.test("ISO country matching rejects cross-country pairs", () => {
  assertEquals(normalizeIsoCountryCode("uk"), "GB");
  assertEquals(normalizeIsoCountryCode("Uganda"), null);
  assertEquals(serviceAreaCountryMatches("GB", "UG"), false);
  assertEquals(serviceAreaCountryMatches("GB", "SO"), false);
  assertEquals(serviceAreaCountryMatches("GB", "gb"), true);
  assertEquals(CORPORATE_SERVICE_UNAVAILABLE_MESSAGE, CORPORATE_UNAVAILABLE);
  let threw = false;
  try {
    assertServiceAreaCountryMatch("GB", "UG");
  } catch (err) {
    threw = err instanceof Error && err.message === SERVICE_AREA_COUNTRY_MISMATCH;
  }
  assertEquals(threw, true);
});

Deno.test("corporate SA catalogue is country-scoped via regions.country_code", async () => {
  const sql = await read("supabase/migrations/20261028120000_corporate_service_area_country_gate.sql");
  assertEquals(sql.includes("get_corporate_service_areas_for_country"), true);
  assertEquals(sql.includes("r.country_code"), true);
  assertEquals(sql.includes("haversine_meters"), true);
  assertEquals(sql.includes("SERVICE_AREA_COUNTRY_MISMATCH"), true);
  assertEquals(sql.includes("REVOKE INSERT ON TABLE public.corporate_account_requests FROM authenticated"), true);
  assertEquals(sql.includes("GRANT EXECUTE ON FUNCTION public.get_corporate_service_areas_for_country"), true);
  assertEquals(sql.includes("TO service_role"), true);
});

Deno.test("submit-corporate-account-request geocodes and rejects cross-country SA", async () => {
  const edge = await read("supabase/functions/submit-corporate-account-request/index.ts");
  assertEquals(edge.includes("geocodeCorporateAddress"), true);
  assertEquals(edge.includes("assertServiceAreaCountryMatch"), true);
  assertEquals(edge.includes("SERVICE_AREA_COUNTRY_MISMATCH"), true);
  assertEquals(edge.includes('"country_code"'), true);
});

Deno.test("corporate hub does not load global active service areas", async () => {
  const hook = await Deno.readTextFile(centralHubPath("src/hooks/useServiceAreas.ts"));
  assertEquals(hook.includes("corporate-service-area-options"), true);
  assertEquals(hook.includes('.from("service_areas")'), false);
  assertEquals(hook.includes("useActiveServiceAreas"), false);

  const index = await Deno.readTextFile(centralHubPath("src/pages/Index.tsx"));
  assertEquals(index.includes("submitCorporateAccountRequest"), true);
  assertEquals(index.includes('from("corporate_account_requests").insert'), false);
  assertEquals(index.includes("useCorporateServiceAreas"), true);

  const gate = await Deno.readTextFile(centralHubPath("src/components/corporate/ServiceAreaGate.tsx"));
  assertEquals(gate.includes("set-corporate-service-area"), true);
  assertEquals(gate.includes("CORPORATE_SERVICE_UNAVAILABLE_MESSAGE"), true);
  assertEquals(gate.includes("useActiveServiceAreas"), false);
  assertEquals(hook.includes(CORPORATE_UNAVAILABLE), true);
});
