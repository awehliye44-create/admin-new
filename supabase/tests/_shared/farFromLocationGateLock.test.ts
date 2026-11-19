/**
 * Bug #48 / Complete Trip — Edge far-from confirmation SSOT.
 * stop-workflow must enforce location_confirmation_required when far without far_confirm.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import {
  evaluateFarFromLocationGate,
  FAR_FROM_LOCATION_WARNING_RADIUS_METERS,
} from "../../functions/_shared/farFromLocationGate.ts";

const ROOT = fromFileUrl(new URL("../../functions", import.meta.url));

Deno.test("far gate allows within radius without far_confirm", () => {
  const gate = evaluateFarFromLocationGate({
    kind: "destination",
    driverLat: 52.04,
    driverLng: -0.76,
    targetLat: 52.0401,
    targetLng: -0.7601,
    farConfirm: false,
  });
  assertEquals(gate.ok, true);
});

Deno.test("far gate requires confirmation beyond radius", () => {
  const gate = evaluateFarFromLocationGate({
    kind: "destination",
    driverLat: 52.04,
    driverLng: -0.76,
    targetLat: 52.1,
    targetLng: -0.76,
    farConfirm: false,
  });
  assertEquals(gate.ok, false);
  if (!gate.ok) {
    assertEquals(gate.code, "location_confirmation_required");
    assertEquals(gate.distanceMeters > FAR_FROM_LOCATION_WARNING_RADIUS_METERS, true);
  }
});

Deno.test("far gate allows with far_confirm when far", () => {
  const gate = evaluateFarFromLocationGate({
    kind: "pickup",
    driverLat: 52.04,
    driverLng: -0.76,
    targetLat: 52.1,
    targetLng: -0.76,
    farConfirm: true,
  });
  assertEquals(gate.ok, true);
});

Deno.test("far gate fail-open when driver coords missing", () => {
  const gate = evaluateFarFromLocationGate({
    kind: "destination",
    driverLat: null,
    driverLng: null,
    targetLat: 52.1,
    targetLng: -0.76,
    farConfirm: false,
  });
  assertEquals(gate.ok, true);
  if (gate.ok) assertEquals(gate.distanceMeters, null);
});

Deno.test("stop-workflow wires far gate for arrive + complete", () => {
  const src = Deno.readTextFileSync(`${ROOT}/stop-workflow/index.ts`);
  assertEquals(src.includes("evaluateFarFromLocationGate"), true);
  assertEquals(src.includes("assertFarFromLocation"), true);
  assertEquals(src.includes("far_confirm"), true);
  assertEquals(src.includes('"destination"'), true);
  assertEquals(src.includes('"pickup"'), true);
  assertEquals(src.includes('"stop"'), true);
});
