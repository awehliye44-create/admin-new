/**
 * #67B lock — preset chips always carry authoritative driverNetPence.
 * Run: deno test --no-check --allow-read supabase/tests/_shared/presetChipDriverNet67bLock.test.ts
 */
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../functions/", import.meta.url);
const migrations = new URL("../../migrations/", import.meta.url);

async function readFn(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, root));
}

Deno.test("driverOfferNetPreview annotates every preset chip", async () => {
  const src = await readFn("_shared/driverOfferNetPreview.ts");
  assertStringIncludes(src, "driverNetPence: net");
  assertStringIncludes(src, "driverNetFromCustomerTotal");
  assertStringIncludes(src, "preset_options");
});

Deno.test("driver-fare-offer enriches snapshot nets before commit", async () => {
  const src = await readFn("driver-fare-offer/index.ts");
  assertStringIncludes(src, "enrichOfferSnapshotDriverNet");
  assertStringIncludes(src, "selected_fare_pence");
});

Deno.test("migration always annotates chip nets outside airport-present gate", async () => {
  const src = await Deno.readTextFile(
    new URL("20261121140000_preset_chip_driver_net_always_67b.sql", migrations),
  );
  assertStringIncludes(src, "#67B: always annotate chip nets");
  assertStringIncludes(src, "offer_annotate_preset_nets");
  assertStringIncludes(src, "enrich_ride_offer_presets");
});
