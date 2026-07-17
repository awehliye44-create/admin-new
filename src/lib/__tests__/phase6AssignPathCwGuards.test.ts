import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Phase 6 assign-path CW error guards", () => {
  it("lost-property return-ride assign checks CW gate and does not book case on failure", () => {
    const src = readFileSync(
      resolve(__dirname, "../../../supabase/functions/lost-property/index.ts"),
      "utf8",
    );
    expect(src).toContain("driver_passes_commission_wallet_dispatch_gate");
    expect(src).toContain("INSUFFICIENT_COMMISSION_WALLET_BALANCE");
    expect(src).toMatch(/tripAssignErr[\s\S]*RETURN_RIDE_BOOKED/);
    // Must check trip assign error before advancing case status.
    const assignIdx = src.indexOf("tripAssignErr");
    const bookedIdx = src.indexOf('status: "RETURN_RIDE_BOOKED"', assignIdx);
    expect(assignIdx).toBeGreaterThan(-1);
    expect(bookedIdx).toBeGreaterThan(assignIdx);
  });

  it("ManualTrip surfaces insufficient commission wallet balance", () => {
    const src = readFileSync(
      resolve(__dirname, "../../pages/ManualTrip.tsx"),
      "utf8",
    );
    expect(src).toContain("INSUFFICIENT_COMMISSION_WALLET_BALANCE");
    expect(src).toContain("insufficient commission wallet balance");
  });
});
