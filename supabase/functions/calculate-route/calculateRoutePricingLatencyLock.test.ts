/**
 * calculate-route pricing latency lock — Choose Ride only needs distance/duration.
 * Never re-add full geometry, annotations, or sequential traffic+driving for Ride Now.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/assert_string_includes.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";

const ROUTE_FN = fromFileUrl(new URL("./index.ts", import.meta.url));

function readRouteFn(): string {
  return Deno.readTextFileSync(ROUTE_FN);
}

Deno.test("calculate-route uses lean Mapbox params for pricing (no geometry/annotations)", () => {
  const src = readRouteFn();
  assertStringIncludes(src, 'overview: includeGeometry ? "full" : "false"');
  assertEquals(src.includes("annotations="), false);
  assertEquals(src.includes('overview: "full"'), false);
  assertStringIncludes(src, 'alternatives: "false"');
  assertStringIncludes(src, 'steps: "false"');
});

Deno.test("calculate-route skips driving-traffic when no valid depart_at (Ride Now)", () => {
  const src = readRouteFn();
  assertStringIncludes(src, '["driving-traffic", "driving"]');
  assertStringIncludes(src, ': ["driving"]');
  assertEquals(/for \(let attempt = 0; attempt < 2/.test(src), false);
});

Deno.test("calculate-route exposes structured timings and short-lived coord cache", () => {
  const src = readRouteFn();
  assertStringIncludes(src, "timings?: RouteTimings");
  assertStringIncludes(src, "ROUTE_CACHE_TTL_MS");
  assertStringIncludes(src, "normalizeCoord");
});

Deno.test("calculate-route keeps mapbox_directions SSOT and haversine fallback", () => {
  const src = readRouteFn();
  assertStringIncludes(src, 'source: "mapbox_directions"');
  assertStringIncludes(src, 'source: "haversine"');
  assertStringIncludes(src, "getHaversineFallback");
});
