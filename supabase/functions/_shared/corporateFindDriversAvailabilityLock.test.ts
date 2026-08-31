/**
 * Lock: Corporate Book a Ride consumes Customer `find-drivers` as the Ride Now
 * availability SSOT. Do not replace this with a local drivers.is_online query
 * or a corporate-only availability Edge Function.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isImmediateAvailabilitySelectable,
  mapFindDriversResponse,
  VEHICLE_NO_LONGER_AVAILABLE_COPY,
} from "../../../../onecab-central-hub/src/lib/findDriversAvailability.ts";

function centralHubPath(rel: string): URL {
  return new URL(`../../../../onecab-central-hub/${rel}`, import.meta.url);
}

async function readHub(rel: string): Promise<string> {
  return await Deno.readTextFile(centralHubPath(rel));
}

async function readAdmin(pathFromRepoRoot: string): Promise<string> {
  const repoRoot = new URL("../../../", import.meta.url);
  return await Deno.readTextFile(new URL(pathFromRepoRoot, repoRoot));
}

Deno.test("mapFindDriversResponse: empty drivers is unavailable", () => {
  const mapped = mapFindDriversResponse({
    success: true,
    drivers: [],
    message: "No drivers available right now.",
  });
  assertEquals(mapped.state, "unavailable");
  assertEquals(isImmediateAvailabilitySelectable(mapped.state), false);
});

Deno.test("mapFindDriversResponse: explicit availability_state unavailable", () => {
  const mapped = mapFindDriversResponse({
    success: true,
    drivers: [],
    availability_state: "unavailable",
  });
  assertEquals(mapped.state, "unavailable");
});

Deno.test("mapFindDriversResponse: eligible drivers are selectable", () => {
  const mapped = mapFindDriversResponse({
    success: true,
    availability_state: "available",
    drivers: [{ id: "d1", eta_min: 4, distance_km: 1.2 }],
  });
  assertEquals(mapped.state, "available");
  assertEquals(mapped.etaMin, 4);
  assertEquals(isImmediateAvailabilitySelectable(mapped.state), true);
});

Deno.test("mapFindDriversResponse: success false is error not unavailable", () => {
  const mapped = mapFindDriversResponse({
    success: false,
    message: "Invalid or expired token",
  });
  assertEquals(mapped.state, "error");
  assertEquals(isImmediateAvailabilitySelectable(mapped.state), false);
});

Deno.test("corporate BookRide invokes find-drivers SSOT, not drivers.is_online", async () => {
  const book = await readHub("src/pages/corporate/BookRide.tsx");
  const hook = await readHub("src/hooks/useFindDriversAvailability.ts");
  const client = await readHub("src/lib/findDriversClient.ts");
  const mapper = await readHub("src/lib/findDriversAvailability.ts");

  assertEquals(mapper.includes('FIND_DRIVERS_FN = "find-drivers"'), true);
  assertEquals(client.includes("FIND_DRIVERS_FN"), true);
  assertEquals(client.includes("assertRideNowVehicleAvailable"), true);
  assertEquals(hook.includes("invokeFindDrivers"), true);
  assertEquals(book.includes("useFindDriversAvailability"), true);
  assertEquals(book.includes("assertRideNowVehicleAvailable"), true);
  assertEquals(book.includes("VEHICLE_NO_LONGER_AVAILABLE_COPY"), true);
  assertEquals(book.includes("NO_DRIVERS_AVAILABLE_COPY"), true);
  assertEquals(mapper.includes(VEHICLE_NO_LONGER_AVAILABLE_COPY), true);
  assertEquals(mapper.includes("No drivers available"), true);
  assertEquals(book.includes('from("drivers")'), false);
  assertEquals(book.includes("is_online"), false);
});

Deno.test("find-drivers remains the availability SSOT (no corporate-only calculator)", async () => {
  const findDrivers = await readAdmin("supabase/functions/find-drivers/index.ts");
  assertEquals(findDrivers.includes("driver_vehicle_categories"), true);
  assertEquals(findDrivers.includes("driver_service_areas"), true);
  assertEquals(findDrivers.includes(".eq('is_online', true)"), true);
  assertEquals(findDrivers.includes(".eq('approval_status', 'approved')"), true);
  assertEquals(findDrivers.includes(".eq('documents_approved', true)"), true);
  assertEquals(findDrivers.includes("availability_state: 'unavailable'"), true);
  assertEquals(findDrivers.includes("availability_state: 'available'"), true);

  let foundCorporateCalculator = false;
  for await (const entry of Deno.readDir(new URL("../", import.meta.url))) {
    if (entry.name.includes("corporate") && entry.name.toLowerCase().includes("avail")) {
      foundCorporateCalculator = true;
    }
  }
  assertEquals(foundCorporateCalculator, false);
});
