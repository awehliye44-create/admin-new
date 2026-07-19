import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  COMMISSION_WALLET_PHASE8_PILOT,
  planCommissionWalletServiceAreaEnablement,
} from "../../../shared/commissionWalletSSOT";

describe("Phase 8 Banadir pilot lock", () => {
  const pilotId = COMMISSION_WALLET_PHASE8_PILOT.service_area_id;
  const locked = {
    pilot_service_area_id: pilotId,
    multi_sa_unlocked: false,
  };

  it("allows Banadir enable while locked", () => {
    expect(
      planCommissionWalletServiceAreaEnablement({
        serviceAreaId: pilotId,
        enabling: true,
        rollout: locked,
      }),
    ).toEqual({ ok: true });
  });

  it("blocks non-pilot enable while locked", () => {
    const plan = planCommissionWalletServiceAreaEnablement({
      serviceAreaId: "cb58f1bd-8b6f-45b9-ad31-b3140309892c",
      enabling: true,
      rollout: locked,
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect((plan as { ok: false; code: string }).code).toBe("PILOT_LOCK");
  });

  it("allows any SA after multi_sa_unlocked", () => {
    expect(
      planCommissionWalletServiceAreaEnablement({
        serviceAreaId: "cb58f1bd-8b6f-45b9-ad31-b3140309892c",
        enabling: true,
        rollout: { ...locked, multi_sa_unlocked: true },
      }),
    ).toEqual({ ok: true });
  });

  it("always allows disable", () => {
    expect(
      planCommissionWalletServiceAreaEnablement({
        serviceAreaId: "cb58f1bd-8b6f-45b9-ad31-b3140309892c",
        enabling: false,
        rollout: locked,
      }),
    ).toEqual({ ok: true });
  });

  it("migration pins Banadir and creates pilot lock", () => {
    const sql = readFileSync(
      resolve(
        __dirname,
        "../../../supabase/migrations/20260831900000_commission_wallet_phase8_pilot_banadir.sql",
      ),
      "utf8",
    );
    expect(sql).toContain(pilotId);
    expect(sql).toContain("Banadir");
    expect(sql).toContain("commission_wallet_rollout");
    expect(sql).toContain("enforce_commission_wallet_pilot_lock");
    expect(sql).toContain("multi_sa_unlocked");
    expect(sql).toContain("commission_reserve_enabled = true");
  });

  it("gap-close migration locks financial_model to pilot", () => {
    const sql = readFileSync(
      resolve(
        __dirname,
        "../../../supabase/migrations/20260831910000_commission_wallet_phase8_gap_close.sql",
      ),
      "utf8",
    );
    expect(sql).toContain("v_adopting_africa_model");
    expect(sql).toContain("DRIVER_COLLECTED_COMMISSION_WALLET");
    expect(sql).toContain("commission_wallet_test_access_admin");
  });

  it("admin config loads rollout and gates enable", () => {
    const src = readFileSync(
      resolve(__dirname, "../../components/finance/ServiceAreaCommissionWalletConfig.tsx"),
      "utf8",
    );
    expect(src).toContain("planCommissionWalletServiceAreaEnablement");
    expect(src).toContain("commission_wallet_rollout");
    expect(src).toContain("COMMISSION_WALLET_PHASE8_PILOT");
    expect(src).toContain("PHASE4_SUPPORTED_TOPUP_PROVIDERS");
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

  it("pass4 auto-grants pilot test_access and clears Banadir digital gateway", () => {
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
