import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Phase 7 admin CW isolation guards", () => {
  it("admin-payment-detail skips DWL for CW trips", () => {
    const src = readFileSync(
      resolve(__dirname, "../../../supabase/functions/admin-payment-detail/index.ts"),
      "utf8",
    );
    expect(src).toContain("tripBlocksDriverWalletLedgerPosting");
  });

  it("record-financial-outcome skips DWL for CW trips", () => {
    const src = readFileSync(
      resolve(__dirname, "../../../supabase/functions/record-financial-outcome/index.ts"),
      "utf8",
    );
    expect(src).toContain("tripBlocksDriverWalletLedgerPosting");
    expect(src).toContain("COMMISSION_WALLET_TRIP");
  });

  it("FR and settlement-summary exclude CW financial_model", () => {
    const fr = readFileSync(
      resolve(__dirname, "../../../supabase/functions/_shared/financialReconciliationSSOT.ts"),
      "utf8",
    );
    const settle = readFileSync(
      resolve(__dirname, "../../../supabase/functions/_shared/financeSettlementSummary.ts"),
      "utf8",
    );
    expect(fr).toContain("excludeTripFromPlatformCollectedFinance");
    expect(settle).toContain("excludeTripFromPlatformCollectedFinance");
  });

  it("admin-finance-reconciliation selects financial_model", () => {
    const src = readFileSync(
      resolve(__dirname, "../../../supabase/functions/admin-finance-reconciliation/index.ts"),
      "utf8",
    );
    expect(src).toContain("financial_model");
  });
});
