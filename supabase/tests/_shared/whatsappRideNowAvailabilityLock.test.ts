/**
 * Lock: WhatsApp / guest web booking must use the same Ride Now nearby-driver
 * availability SSOT as Customer Choose Ride (`find-drivers` /
 * findDriversAvailabilitySSOT). Priced catalogue alone is not availability.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

async function readAdmin(pathFromRepoRoot: string): Promise<string> {
  const repoRoot = new URL("../../../", import.meta.url);
  return await Deno.readTextFile(new URL(pathFromRepoRoot, repoRoot));
}

Deno.test("findDriversAvailabilitySSOT encodes Customer eligibility rules", async () => {
  const ssot = await readAdmin("supabase/functions/_shared/findDriversAvailabilitySSOT.ts");
  assertEquals(ssot.includes(".eq(\"is_online\", true)"), true);
  assertEquals(ssot.includes(".eq(\"approval_status\", \"approved\")"), true);
  assertEquals(ssot.includes(".eq(\"documents_approved\", true)"), true);
  assertEquals(ssot.includes("driver_service_areas"), true);
  assertEquals(ssot.includes("driver_vehicle_categories"), true);
  assertEquals(ssot.includes("is_default"), true);
  // Pet-Friendly OFF must not count toward Ride Now availability (parity with dispatch).
  assertEquals(ssot.includes("driver_controllable"), true);
  assertEquals(ssot.includes("is_pet_friendly"), true);
  assertEquals(ssot.includes("assertRideNowVehicleAvailableOrError"), true);
  assertEquals(ssot.includes("isImmediateRideNowBooking"), true);
  assertEquals(ssot.includes("evaluateRideNowAvailabilityForVehicleTypes"), true);
});

Deno.test("find-drivers delegates to shared Ride Now SSOT", async () => {
  const findDrivers = await readAdmin("supabase/functions/find-drivers/index.ts");
  assertEquals(findDrivers.includes("evaluateRideNowVehicleAvailability"), true);
  assertEquals(findDrivers.includes("findDriversAvailabilitySSOT"), true);
  assertEquals(findDrivers.includes("availability_state: \"unavailable\""), true);
  assertEquals(findDrivers.includes("availability_state: \"available\""), true);
});

Deno.test("whatsapp-booking-fares annotates vehicleFares with availability_state", async () => {
  const fares = await readAdmin("supabase/functions/whatsapp-booking-fares/index.ts");
  assertEquals(fares.includes("evaluateRideNowAvailabilityForVehicleTypes"), true);
  assertEquals(fares.includes("availability_state"), true);
  assertEquals(fares.includes("isImmediateRideNowBooking"), true);
  // Must not invent a WhatsApp-only nearby calculator.
  assertEquals(fares.includes('from("drivers")'), false);
});

Deno.test("guest pay and corporate/customer book Edges re-assert Ride Now availability", async () => {
  const guest = await readAdmin("supabase/functions/create-guest-payment-intent/index.ts");
  const corporate = await readAdmin("supabase/functions/create-corporate-book/index.ts");
  const customer = await readAdmin("supabase/functions/create-trip-after-payment/index.ts");

  assertEquals(guest.includes("assertRideNowVehicleAvailableOrError"), true);
  assertEquals(corporate.includes("assertRideNowVehicleAvailableOrError"), true);
  assertEquals(customer.includes("assertRideNowVehicleAvailableOrError"), true);
});
