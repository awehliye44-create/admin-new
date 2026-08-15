/**
 * Lock: search-onecab-locations uses locationBias, never a hard restriction circle.
 * Run: deno test --allow-read supabase/functions/_shared/searchOnecabLocationsBiasLock.test.ts
 */
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const src = await Deno.readTextFile(
  new URL("../search-onecab-locations/index.ts", import.meta.url),
);

Deno.test("uses locationBias instead of locationRestriction", () => {
  assert(src.includes("locationBias"));
  assert(!src.includes("locationRestriction"));
  assert(src.includes("Bias nearby first"));
});

Deno.test("does not drop Google rows beyond the bias radius", () => {
  assert(!src.includes("if (distance > radius) continue"));
  assert(!src.includes("never surface anything beyond the operating radius"));
});

Deno.test("Google HTTP errors are not returned as empty success", () => {
  assert(src.includes("success: false"));
  assert(src.includes("SEARCH_UNAVAILABLE"));
  assert(!src.includes("landmarks_only_provider_error"));
});

Deno.test("does not hardcode a country", () => {
  assert(!src.includes("country:gb"));
  assert(!src.includes('regionCode: "GB"'));
  assert(!src.includes("includedPrimaryTypes"));
});
