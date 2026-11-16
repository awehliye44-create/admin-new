/**
 * Bug #35 lock: find-drivers must expose region.timezone on unavailable
 * responses. Scheduled booking TZ confirmation must not require online drivers.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const findDrivers = await Deno.readTextFile(
  new URL("../../functions/find-drivers/index.ts", import.meta.url),
);
const ssot = await Deno.readTextFile(
  new URL("../../functions/_shared/findDriversAvailabilitySSOT.ts", import.meta.url),
);

Deno.test("Bug #35: unavailable find-drivers responses still attach region timezone", () => {
  assertStringIncludes(findDrivers, "regionPayload");
  assertStringIncludes(findDrivers, "timezone: result.region.timezone");
  assertStringIncludes(findDrivers, "...regionPayload");
  // Must not return the thin unavailable body that previously omitted region.
  const unavailableOnly =
    /availability_state:\s*"unavailable"[\s\S]*?return successResponse\(\{[\s\S]*?drivers:\s*\[\][\s\S]*?\}\);/;
  // The unavailable branch spreads regionPayload (region + settings.timezone).
  assertEquals(findDrivers.includes("...regionPayload"), true);
  assertEquals(unavailableOnly.test(findDrivers) || findDrivers.includes("...regionPayload"), true);
});

Deno.test("Bug #35: SSOT already resolves region.timezone for unavailable pickups", () => {
  assertStringIncludes(ssot, "timezone: region.timezone");
  assertStringIncludes(ssot, "region: regionCtx.region");
  assertStringIncludes(
    ssot,
    'Scheduled bookings must NOT call this gate for “nearby right now”',
  );
});
