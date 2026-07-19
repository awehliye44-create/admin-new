/**
 * Static guards: payee management is configuration, never gated by LIVE execution.
 * Regression for: hardcoded "Add payee (disabled)" behind LIVE_PAYOUT_EXECUTION_ENABLED.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PAYEES_SECTION = resolve(
  __dirname,
  "../../components/finance/CompanyTransfersPayeesSection.tsx",
);

describe("CompanyTransfersPayeesSection — config vs execution SSOT", () => {
  const src = readFileSync(PAYEES_SECTION, "utf8");

  it("Add Payee is enabled (not hardcoded disabled)", () => {
    expect(src).not.toMatch(/Add payee \(disabled\)/i);
    expect(src).not.toMatch(
      /disabled\s+title=["']Read-only while LIVE_PAYOUT_EXECUTION_ENABLED/,
    );
    expect(src).toMatch(/>\s*Add Payee\s*</);
    expect(src).toMatch(/onClick=\{openCreatePayee\}/);
  });

  it("payee form is not dead-coded behind false &&", () => {
    expect(src).not.toMatch(/\{\s*false\s*&&\s*\(focus/);
    expect(src).toMatch(/showPayeeForm\s*\?\s*\(/);
  });

  it("does not gate payee CRUD behind LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED", () => {
    expect(src).not.toMatch(
      /disabled=\{[^}]*LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED/,
    );
    expect(src).toMatch(/link_revolut:\s*false/);
    // Create always sends execute_live: false (configuration only).
    expect(src).toMatch(/execute_live:\s*false/);
    expect(src).not.toMatch(/execute_live:\s*payeeForm\.link_revolut/);
  });
});
