/**
 * calculate-fare pricing latency lock — parallel SA-id reads, slim selects,
 * one-shot zone containment, structured timings. Never re-serialise Wave1→2→3→4
 * or restore select("*") on the quote path.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/assert_string_includes.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";

const FARE_FN = fromFileUrl(new URL("./index.ts", import.meta.url));
const ENGINE = fromFileUrl(new URL("../_shared/pricing-engine.ts", import.meta.url));

Deno.test("calculate-fare launches SA-id-only reads before awaiting region", () => {
  const src = Deno.readTextFileSync(FARE_FN);
  assertStringIncludes(src, "vehiclePricingPromise");
  assertStringIncludes(src, "airportPromise");
  assertStringIncludes(src, "routesPromise");
  assertStringIncludes(src, "surgePromise");
  assertStringIncludes(src, "fareSettingsPromise");
  // Surge uses request pickup/SA only — launched with Wave A, not after zones await.
  assertStringIncludes(src, "resolve_zone_surge");
  assertStringIncludes(src, "const surgePromise = pickup");
  assertStringIncludes(src, 'from("custom_zones")');
});

Deno.test("calculate-fare uses slim fare_pricing_settings / custom_zones selects", () => {
  const src = Deno.readTextFileSync(FARE_FN);
  assertStringIncludes(src, "FARE_PRICING_SETTINGS_QUOTE_SELECT");
  assertStringIncludes(src, "CUSTOM_ZONES_QUOTE_SELECT");
  assert(!src.includes('.select("*")'), "must not select(*) on quote path");
});

Deno.test("calculate-fare detects zones once per quote and returns timings", () => {
  const src = Deno.readTextFileSync(FARE_FN);
  assertStringIncludes(src, "zonesContainingPoint(pickup, zones)");
  assertStringIncludes(src, "pickupContainingZones");
  assertStringIncludes(src, "dropoffContainingZones");
  assertStringIncludes(src, "total_edge_ms");
  assertStringIncludes(src, "timings");
});

Deno.test("pricing-engine exports quote selects and accepts precomputed containing zones", () => {
  const src = Deno.readTextFileSync(ENGINE);
  assertStringIncludes(src, "FARE_PRICING_SETTINGS_QUOTE_SELECT");
  assertStringIncludes(src, "CUSTOM_ZONES_QUOTE_SELECT");
  assertStringIncludes(src, "pickupContainingZones");
  assertStringIncludes(src, "dropoffContainingZones");
});
