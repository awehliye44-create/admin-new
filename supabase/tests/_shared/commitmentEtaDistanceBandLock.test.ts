/**
 * MK-261116-009 — commitment ETA must not treat inter-town legs as 20 km/h crawl.
 *
 * deno test --allow-read supabase/tests/_shared/commitmentEtaDistanceBandLock.test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";
import {
  commitmentEtaAverageSpeedKmh,
  estimateEtaMinutes,
} from "../../functions/_shared/scheduledDispatchConfig.ts";
import {
  evaluateScheduledCommitmentFeasibility,
} from "../../functions/_shared/scheduledCommitmentFeasibilitySSOT.ts";
import {
  SCHEDULED_JIT_ACTIVATION_DEFAULTS,
} from "../../functions/_shared/scheduledJitActivationSSOT.ts";

const REPO = fromFileUrl(new URL("../../..", import.meta.url));

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(join(REPO, rel));
}

Deno.test("distance-banded speeds: urban crawl vs corridor", () => {
  assertEquals(commitmentEtaAverageSpeedKmh(2), 20);
  assertEquals(commitmentEtaAverageSpeedKmh(10), 32);
  assertEquals(commitmentEtaAverageSpeedKmh(21), 45);
  assertEquals(commitmentEtaAverageSpeedKmh(50), 55);
});

Deno.test("MK-261116-009 class: 6 min local trip ~1h before Aylesbury scheduled is feasible", () => {
  // Dropoff Barnsdale Grove → Avondale Care Home scheduled pickup.
  const travel = estimateEtaMinutes(
    52.004864,
    -0.7947194,
    51.81915,
    -0.8219167,
  );
  assert(travel != null && travel > 0);
  // Flat 20 km/h produced ~91; banded corridor must stay well under an hour.
  assert(travel! < 55, `travel=${travel} still too pessimistic`);

  const nowMs = Date.parse("2026-11-16T19:29:40Z");
  const scheduledAtMs = Date.parse("2026-11-16T20:30:00Z");
  const feasibility = evaluateScheduledCommitmentFeasibility({
    nowMs,
    remainingJourneyMinutes: 6,
    travelToPickupEtaMinutes: travel!,
    scheduledAtMs,
    config: SCHEDULED_JIT_ACTIVATION_DEFAULTS,
  });
  assertEquals(feasibility.feasible, true);
  assertEquals(feasibility.reason, "ok");
});

Deno.test("Edge + SQL stay mirrored on distance-banded commitment ETA", async () => {
  const ts = await read("supabase/functions/_shared/scheduledDispatchConfig.ts");
  assertStringIncludes(ts, "commitmentEtaAverageSpeedKmh");
  assertStringIncludes(ts, "COMMITMENT_ETA_ROAD_FACTOR = 1.45");
  assert(!/avgSpeedKmh = 20; \/\/ slower than typical city average/.test(ts));

  const sql = await read(
    "supabase/migrations/20261116193000_commitment_eta_distance_banded_speed.sql",
  );
  assertStringIncludes(sql, "scheduled_commitment_estimate_eta_minutes");
  assertStringIncludes(sql, "v_speed := 20");
  assertStringIncludes(sql, "v_speed := 32");
  assertStringIncludes(sql, "v_speed := 45");
  assertStringIncludes(sql, "v_speed := 55");
  assertStringIncludes(sql, "v_km * 1.45 / v_speed");
});
