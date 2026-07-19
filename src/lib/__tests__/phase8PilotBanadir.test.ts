import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  COMMISSION_WALLET_PHASE8_PILOT,
  SERVICE_AREA_FINANCIAL_MODEL,
  planCommissionWalletServiceAreaEnablement,
} from "../../../shared/commissionWalletSSOT";

describe("Commission Wallet multi-SA enablement (no Banadir pilot lock)", () => {
  it("allows any SA when financial model is DRIVER_COLLECTED", () => {
    expect(
      planCommissionWalletServiceAreaEnablement({
        enabling: true,
        financialModel: SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
        serviceAreaId: "cb58f1bd-8b6f-45b9-ad31-b3140309892c",
      }),
    ).toEqual({ ok: true });
    expect(
      planCommissionWalletServiceAreaEnablement({
        enabling: true,
        financialModel: SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
        serviceAreaId: COMMISSION_WALLET_PHASE8_PILOT.service_area_id,
      }),
    ).toEqual({ ok: true });
  });

  it("blocks enable under PLATFORM_COLLECTED", () => {
    const plan = planCommissionWalletServiceAreaEnablement({
      enabling: true,
      financialModel: SERVICE_AREA_FINANCIAL_MODEL.PLATFORM_COLLECTED,
      serviceAreaId: COMMISSION_WALLET_PHASE8_PILOT.service_area_id,
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe("FINANCIAL_MODEL_REQUIRED");
  });

  it("always allows disable", () => {
    expect(
      planCommissionWalletServiceAreaEnablement({
        enabling: false,
        financialModel: SERVICE_AREA_FINANCIAL_MODEL.PLATFORM_COLLECTED,
      }),
    ).toEqual({ ok: true });
  });

  it("ignores deprecated rollout/pilot args (no SA name lock)", () => {
    expect(
      planCommissionWalletServiceAreaEnablement({
        enabling: true,
        financialModel: SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
        serviceAreaId: "any-sa-id",
        rollout: {
          pilot_service_area_id: COMMISSION_WALLET_PHASE8_PILOT.service_area_id,
          multi_sa_unlocked: false,
        },
      }),
    ).toEqual({ ok: true });
  });

  it("unlock migration removes pilot lock trigger", () => {
    const sql = readFileSync(
      resolve(
        __dirname,
        "../../../supabase/migrations/20260832130000_commission_wallet_multi_sa_unlock.sql",
      ),
      "utf8",
    );
    expect(sql).toContain("multi_sa_unlocked = true");
    expect(sql).toContain("trg_enforce_commission_wallet_pilot_lock");
    expect(sql).toContain("enforce_commission_wallet_financial_model");
    expect(sql).toContain("DROP FUNCTION IF EXISTS public.enforce_commission_wallet_pilot_lock()");
    expect(sql).not.toContain("Banadir may enable");
  });

  it("historical Phase 8 migrations remain as audit artifacts", () => {
    const sql = readFileSync(
      resolve(
        __dirname,
        "../../../supabase/migrations/20260831900000_commission_wallet_phase8_pilot_banadir.sql",
      ),
      "utf8",
    );
    expect(sql).toContain(COMMISSION_WALLET_PHASE8_PILOT.service_area_id);
    expect(sql).toContain("enforce_commission_wallet_pilot_lock");
  });

  it("admin config uses financial_model gate only (no pilot UI)", () => {
    const src = readFileSync(
      resolve(__dirname, "../../components/finance/ServiceAreaCommissionWalletConfig.tsx"),
      "utf8",
    );
    expect(src).toContain("planCommissionWalletServiceAreaEnablement");
    expect(src).toContain("PHASE4_SUPPORTED_TOPUP_PROVIDERS");
    expect(src).toContain("DRIVER_COLLECTED_COMMISSION_WALLET");
    expect(src).not.toContain("COMMISSION_WALLET_PHASE8_PILOT");
    expect(src).not.toContain("commission_wallet_rollout");
    expect(src).not.toContain("pilot lock");
    expect(src).not.toContain("Banadir");
    expect(src).not.toContain("sifalo_pay");
  });

  it("overview counts only trip CW snapshots", () => {
    const src = readFileSync(
      resolve(
        __dirname,
        "../../../supabase/functions/admin-commission-wallet-overview/index.ts",
      ),
      "utf8",
    );
    expect(src).toContain('eq("financial_model", "DRIVER_COLLECTED_COMMISSION_WALLET")');
    expect(src).toContain('eq("commission_wallet_enabled", true)');
  });

  it("finance-summary excludes CW trips from UK commissionable loop", () => {
    const src = readFileSync(
      resolve(
        __dirname,
        "../../../supabase/functions/admin-finance-summary/index.ts",
      ),
      "utf8",
    );
    expect(src).toContain("excludeTripFromPlatformCollectedFinance");
    expect(src).toContain("financial_model");
  });

  it("ManualTrip snapshots CW financial model", () => {
    const src = readFileSync(
      resolve(__dirname, "../../pages/ManualTrip.tsx"),
      "utf8",
    );
    expect(src).toContain("buildTripFinancialModelSnapshot");
    expect(src).toContain("tripInsertFieldsFromFinancialModelSnapshot");
    expect(src).toContain("tripCashUpfrontPaymentFields");
    expect(src).toContain("shouldSkipPlatformPreauthForCommissionWallet");
  });

  it("pass4 historical auto-grant remains as audit artifact", () => {
    const sql = readFileSync(
      resolve(
        __dirname,
        "../../../supabase/migrations/20260831920000_commission_wallet_phase8_gap_close_pass4.sql",
      ),
      "utf8",
    );
    expect(sql).toContain("auto_grant_commission_wallet_pilot_test_access");
    expect(sql).toContain("payment_provider = NULL");
  });

  it("lost-property return booking snapshots CW", () => {
    const src = readFileSync(
      resolve(__dirname, "../../../supabase/functions/lost-property/index.ts"),
      "utf8",
    );
    expect(src).toContain("buildTripFinancialModelSnapshot");
    expect(src).toContain("tripCashUpfrontPaymentFields");
  });
});
