import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Trip/Driver ID SSOT allocators", () => {
  const sql = readFileSync(
    resolve(__dirname, "../../../supabase/migrations/20260832140000_trip_driver_id_ssot_allocators.sql"),
    "utf8",
  );

  it("defines canonical allocate_trip_reference and allocate_driver_reference", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.allocate_trip_reference");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.allocate_driver_reference");
  });

  it("refuses first-SA / region / UNK fallbacks", () => {
    expect(sql).toContain("no first-SA fallback");
    expect(sql).toContain("DRIVER_ID_REQUIRED_SERVICE_AREA");
    expect(sql).toContain("TRIP_ID_REQUIRED_SERVICE_AREA");
    expect(sql).not.toMatch(/ORDER BY created_at LIMIT 1/);
  });

  it("locks prefixes after issuance", () => {
    expect(sql).toContain("trip_id_prefix_locked");
    expect(sql).toContain("driver_id_prefix_locked");
    expect(sql).toContain("TRIP_PREFIX_LOCKED");
    expect(sql).toContain("DRIVER_PREFIX_LOCKED");
  });

  it("protects trip_code immutability for rematch", () => {
    expect(sql).toContain("protect_trip_code_immutable");
    expect(sql).toContain("TRIP_ID_IMMUTABLE");
  });

  it("uses atomic sequences with max reconciliation (not COUNT+1)", () => {
    expect(sql).toContain("id_sequences");
    expect(sql).toContain("service_area_sequences");
    expect(sql).toContain("never fill gaps");
    // Allocator body must not compute next id via COUNT(*)+1 (comment mention is OK).
    const body = sql
      .split("CREATE OR REPLACE FUNCTION public.allocate_driver_reference")[1]
      ?.split("COMMENT ON FUNCTION")[0]
      ?? "";
    expect(body).not.toMatch(/^\s*[^-\n]*COUNT\(\*\)\s*\+\s*1/m);
  });
});
