/**
 * deno test --allow-read supabase/functions/_shared/customerLiveTripEtaSSOT.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveAuthoritativeLiveTripEta,
  resolveLiveTripEtaLeg,
} from "./customerLiveTripEtaSSOT.ts";

Deno.test("resolveLiveTripEtaLeg maps lifecycle stages", () => {
  assertEquals(resolveLiveTripEtaLeg("heading_to_pickup"), "driver_to_pickup");
  assertEquals(resolveLiveTripEtaLeg("trip_started"), "pickup_to_dropoff");
  assertEquals(resolveLiveTripEtaLeg("intermediate_stop"), "pickup_to_dropoff");
  assertEquals(resolveLiveTripEtaLeg("at_pickup"), null);
  assertEquals(resolveLiveTripEtaLeg("finding_new_driver"), null);
});

Deno.test("route cache ETA uses eta_at remaining minutes without new routing", () => {
  const nowMs = Date.parse("2026-11-14T12:00:00Z");
  const resolved = resolveAuthoritativeLiveTripEta({
    lifecycleStage: "heading_to_pickup",
    showDriver: true,
    nowMs,
    cachedRoute: {
      duration_min: 12,
      eta_at: "2026-11-14T12:07:00Z",
      expires_at: "2026-11-14T12:01:30Z",
    },
  });
  assertEquals(resolved.source, "route_cache");
  assertEquals(resolved.etaMinutes, 7);
  assertEquals(resolved.fresh, true);
  assertEquals(resolved.etaLabel, "7 min");
});

Deno.test("expired cache yields Updating label rather than inventing ETA", () => {
  const nowMs = Date.parse("2026-11-14T12:00:00Z");
  const resolved = resolveAuthoritativeLiveTripEta({
    lifecycleStage: "trip_started",
    showDriver: true,
    nowMs,
    cachedRoute: {
      duration_min: 20,
      eta_at: "2026-11-14T12:20:00Z",
      expires_at: "2026-11-14T11:59:00Z",
    },
  });
  assertEquals(resolved.source, "route_cache");
  assertEquals(resolved.fresh, false);
  assertEquals(resolved.etaLabel, "Updating…");
});

Deno.test("rematch / no-driver clears ETA", () => {
  const resolved = resolveAuthoritativeLiveTripEta({
    lifecycleStage: "finding_new_driver",
    showDriver: false,
    etaOverrideMinutes: 9,
    lastEtaMinutes: 9,
  });
  assertEquals(resolved.etaMinutes, null);
  assertEquals(resolved.etaLabel, null);
  assertEquals(resolved.source, "unavailable");
});

Deno.test("publish / APNs / refresh contracts keep platform independence", async () => {
  const flag = await Deno.readTextFile(
    new URL("./customerLiveTripFeatureFlag.ts", import.meta.url),
  );
  const publish = await Deno.readTextFile(
    new URL("../publish-customer-live-trip/index.ts", import.meta.url),
  );
  const refresh = await Deno.readTextFile(
    new URL("../refresh-customer-live-trip-etas/index.ts", import.meta.url),
  );
  const tripRoute = await Deno.readTextFile(
    new URL("../trip-route/index.ts", import.meta.url),
  );
  assertEquals(flag.includes("androidEnabled"), true);
  assertEquals(flag.includes("iosEnabled"), true);
  assertEquals(flag.includes("liveActivityApnsConfigured"), true);
  assertEquals(publish.includes("peekTripRouteCacheLeg"), true);
  assertEquals(publish.includes("emergencyEndExisting"), true);
  assertEquals(publish.includes("allowIosFanout"), true);
  assertEquals(publish.includes("allowAndroidFanout"), true);
  assertEquals(refresh.includes("force_end"), true);
  assertEquals(tripRoute.includes("publishCustomerLiveTripBestEffort"), true);
});
