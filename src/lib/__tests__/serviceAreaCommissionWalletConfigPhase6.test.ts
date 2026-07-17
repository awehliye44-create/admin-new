import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("ServiceAreaCommissionWalletConfig Phase 6 reserve", () => {
  const src = readFileSync(
    resolve(__dirname, "../../components/finance/ServiceAreaCommissionWalletConfig.tsx"),
    "utf8",
  );

  it("persists commission_reserve_enabled and forces it off when wallet disabled", () => {
    expect(src).toContain("commission_reserve_enabled");
    expect(src).toMatch(/commission_reserve_enabled:\s*\n?\s*value\.commission_wallet_enabled && value\.commission_reserve_enabled/);
    expect(src).toContain("Commission reserve (dispatch)");
    expect(src).not.toContain("Dispatch reserve stays off until Phase 6");
    expect(src).not.toContain("Does not enable dispatch gate yet");
  });
});
