/**
 * Towards Destination dispatch — expired sessions must not filter offers.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import {
  buildTowardsDestinationMap,
  isTowardsDestinationSessionActive,
  isValidTowardsDestinationCoord,
} from "../../functions/_shared/towardsDestinationDispatchFilter.ts";

const ROOT = fromFileUrl(new URL("../../functions", import.meta.url));

Deno.test("expired towards destination is inactive", () => {
  assertEquals(
    isTowardsDestinationSessionActive({
      active: true,
      lat: 52.04,
      lng: -0.76,
      expiresAt: "2020-01-01T00:00:00.000Z",
      nowMs: Date.parse("2026-11-19T00:00:00.000Z"),
    }),
    false,
  );
});

Deno.test("active unexpired towards destination is active", () => {
  assertEquals(
    isTowardsDestinationSessionActive({
      active: true,
      lat: 52.04,
      lng: -0.76,
      expiresAt: "2099-01-01T00:00:00.000Z",
      nowMs: Date.parse("2026-11-19T00:00:00.000Z"),
    }),
    true,
  );
});

Deno.test("Null Island coords are invalid", () => {
  assertEquals(isValidTowardsDestinationCoord(0, 0), false);
  assertEquals(isValidTowardsDestinationCoord(52.04, -0.76), true);
});

Deno.test("buildTowardsDestinationMap excludes expired rows", () => {
  const map = buildTowardsDestinationMap(
    [
      {
        driver_id: "d1",
        towards_destination_active: true,
        towards_destination_lat: 52.04,
        towards_destination_lng: -0.76,
        towards_destination_expires_at: "2020-01-01T00:00:00.000Z",
      },
      {
        driver_id: "d2",
        towards_destination_active: true,
        towards_destination_lat: 52.1,
        towards_destination_lng: -0.7,
        towards_destination_expires_at: "2099-01-01T00:00:00.000Z",
      },
    ],
    Date.parse("2026-11-19T00:00:00.000Z"),
  );
  assertEquals(map.has("d1"), false);
  assertEquals(map.has("d2"), true);
});

Deno.test("auto-dispatch uses buildTowardsDestinationMap + expires_at select", () => {
  const src = Deno.readTextFileSync(`${ROOT}/auto-dispatch/index.ts`);
  assertEquals(src.includes("buildTowardsDestinationMap"), true);
  assertEquals(src.includes("towards_destination_expires_at"), true);
  assertEquals(src.includes("isValidTowardsDestinationCoord"), true);
});

Deno.test("SQL Wave-1 migration gates TD via helper + dispatch_trip_offers reject_reason", () => {
  const migRoot = fromFileUrl(new URL("../../migrations", import.meta.url));
  const files = Array.from(Deno.readDirSync(migRoot))
    .map((e) => e.name)
    .filter((n) => n.includes("sql_wave_towards_destination_filter"));
  assertEquals(files.length >= 1, true);
  const sql = Deno.readTextFileSync(`${migRoot}/${files[0]}`);
  assertEquals(sql.includes("towards_destination_sql_wave_allows_driver"), true);
  assertEquals(sql.includes("towards_destination_mismatch"), true);
  assertEquals(sql.includes("dispatch_trip_offers"), true);
  // Expired sessions must not hard-filter (Edge parity).
  assertEquals(sql.includes("v_expires <= p_now"), true);
});
