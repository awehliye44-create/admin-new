import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("ServiceAreaCommissionWalletConfig — no pre-trip reserve", () => {
  const src = readFileSync(
    resolve(__dirname, "../../components/finance/ServiceAreaCommissionWalletConfig.tsx"),
    "utf8",
  );

  it("forces commission_reserve_enabled off and exposes explicit top-up toggle", () => {
    expect(src).toContain("commission_reserve_enabled: false");
    expect(src).toContain("commission_wallet_topup_enabled");
    expect(src).toContain("Driver Top Up");
    expect(src).toContain("Pre-trip commission reservation is permanently disabled");
    expect(src).not.toContain("Commission reserve (dispatch)");
    expect(src).toContain(
      "Enable a valid top-up provider before turning on driver Top Up",
    );
  });
});
