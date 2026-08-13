/**
 * Driver Commission Wallet summary — read-only SSOT.
 * Visible when SA financial_model = DRIVER_COLLECTED_COMMISSION_WALLET
 * AND commission_wallet_enabled = true (canonical service area only).
 * Never writes driver_wallet_ledger or commission ledger.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { resolveDriverServiceAreaId } from "../_shared/resolveDriverServiceAreaId.ts";
import {
  COMMISSION_WALLET_DRIVER_PAGE_DISCLAIMER,
  COMMISSION_WALLET_FORBIDDEN_ACTIONS,
  COMMISSION_WALLET_ENTRY_TYPE,
  deriveBalancesFromCommissionLedgerEntries,
  isCampaignActiveInWindow,
  isDriverVisibleCommissionWalletEntryType,
  isTopUpBonusCampaignType,
  planDriverCommissionWalletPageAccess,
  resolveCommissionWalletBalanceStatus,
  shouldApplyCommissionWalletDispatchGate,
  shouldEnableDriverCommissionWalletTopup,
} from "../../../shared/commissionWalletSSOT.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ success: false, error: "No authorization header" }, 401);
    }

    const token = authHeader.replace("Bearer ", "");
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser(token);
    if (authError || !user?.id) {
      return json({ success: false, error: "Unauthorized" }, 401);
    }
    const userId = user.id;

    const body = await req.json().catch(() => ({})) as { limit?: number };
    const limit = Math.min(100, Math.max(1, Math.round(Number(body.limit) || 40)));

    const { data: driver, error: driverError } = await supabase
      .from("drivers")
      .select("id, service_area_id, commission_wallet_test_access")
      .eq("user_id", userId)
      .maybeSingle();

    if (driverError || !driver) {
      // Missing column / schema lag: hide page instead of hard 404 for pilots.
      const msg = String(driverError?.message ?? "");
      if (/commission_wallet_test_access|column/i.test(msg)) {
        return json({
          success: true,
          phase: 3,
          page_visible: false,
          code: "NOT_TEST_DRIVER",
          error: "Commission Wallet test access column unavailable",
          disclaimer: COMMISSION_WALLET_DRIVER_PAGE_DISCLAIMER,
          forbidden_actions: COMMISSION_WALLET_FORBIDDEN_ACTIONS,
        });
      }
      return json({ success: false, error: "Driver not found" }, 404);
    }

    const serviceAreaId = await resolveDriverServiceAreaId(
      supabase,
      driver.id,
      driver.service_area_id,
    );

    let saConfig = null as Record<string, unknown> | null;
    if (serviceAreaId) {
      const { data: sa } = await supabase
        .from("service_areas")
        .select(
          "id, name, financial_model, commission_wallet_enabled, commission_wallet_currency, commission_wallet_minimum_balance_minor, commission_topup_provider, commission_wallet_topup_enabled, currency_code, customer_payment_policy",
        )
        .eq("id", serviceAreaId)
        .maybeSingle();
      saConfig = sa;
    }

    const access = planDriverCommissionWalletPageAccess({
      config: saConfig
        ? {
          financial_model: saConfig.financial_model as string,
          commission_wallet_enabled: saConfig.commission_wallet_enabled as boolean,
        }
        : null,
      commissionWalletTestAccess: true,
      hasServiceArea: Boolean(serviceAreaId),
    });

    if (!access.ok) {
      return json({
        success: true,
        phase: 3,
        page_visible: false,
        code: access.code,
        error: access.error,
        disclaimer: COMMISSION_WALLET_DRIVER_PAGE_DISCLAIMER,
        forbidden_actions: COMMISSION_WALLET_FORBIDDEN_ACTIONS,
      });
    }

    const { data: ledgerRows, error: ledgerErr } = await supabase
      .from("driver_commission_wallet_ledger")
      .select(
        "id, entry_type, credit_type, amount_minor, direction, currency, reason, promotional_portion_minor, purchased_portion_minor, created_at, trip_id, metadata",
      )
      .eq("driver_id", driver.id)
      .eq("service_area_id", serviceAreaId!)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (ledgerErr) {
      return json({ success: false, error: ledgerErr.message }, 500);
    }

    // Full history for accurate balances (capped)
    const { data: balanceRows } = await supabase
      .from("driver_commission_wallet_ledger")
      .select(
        "entry_type, amount_minor, direction, promotional_portion_minor, purchased_portion_minor",
      )
      .eq("driver_id", driver.id)
      .eq("service_area_id", serviceAreaId!)
      .order("created_at", { ascending: true })
      .limit(10000);

    const balances = deriveBalancesFromCommissionLedgerEntries(balanceRows ?? []);
    const currency = String(
      saConfig?.commission_wallet_currency
        || saConfig?.currency_code
        || ledgerRows?.[0]?.currency
        || "USD",
    ).toUpperCase();
    const minimumMinor = Number(saConfig?.commission_wallet_minimum_balance_minor || 0);
    const topupEnabled = shouldEnableDriverCommissionWalletTopup({
      config: saConfig
        ? {
          financial_model: saConfig.financial_model as string,
          commission_wallet_enabled: saConfig.commission_wallet_enabled as boolean,
          commission_topup_provider: saConfig.commission_topup_provider as string | null,
          commission_wallet_topup_enabled: saConfig.commission_wallet_topup_enabled === true,
        }
        : null,
    });

    const dispatchGateApplies = shouldApplyCommissionWalletDispatchGate(
      saConfig
        ? {
          financial_model: saConfig.financial_model as string,
          commission_wallet_enabled: saConfig.commission_wallet_enabled as boolean,
        }
        : null,
    );
    const commissionWalletBalance = balances.commission_wallet_balance_minor;
    const belowMinimum = commissionWalletBalance < minimumMinor;
    let offerEligibilityStatus: "eligible" | "blocked" | "not_gated" = "not_gated";
    let offerEligibilityReason =
      "Offer eligibility follows normal dispatch rules for this service area.";
    if (dispatchGateApplies) {
      if (commissionWalletBalance < minimumMinor || (minimumMinor <= 0 && commissionWalletBalance <= 0)) {
        offerEligibilityStatus = "blocked";
        offerEligibilityReason = belowMinimum && minimumMinor > 0
          ? "Commission Wallet balance is below the minimum required for new offers."
          : "Commission Wallet balance is too low for new offers.";
      } else {
        offerEligibilityStatus = "eligible";
        offerEligibilityReason =
          "Commission Wallet balance meets the minimum for offer eligibility.";
      }
    }

    // Driver privacy: never return commission deductions / trip commission internals.
    const driverVisibleRows = (ledgerRows ?? []).filter((row) =>
      isDriverVisibleCommissionWalletEntryType(String(row.entry_type ?? ""))
    );

    const topUpCreditRows = (balanceRows ?? []).filter((row) =>
      String(row.entry_type ?? "").toUpperCase() === COMMISSION_WALLET_ENTRY_TYPE.TOP_UP_CREDIT
    );
    const totalToppedUpMinor = topUpCreditRows.reduce((sum, row) => {
      const amount = Math.max(0, Math.round(Number(row.amount_minor) || 0));
      return sum + amount;
    }, 0);

    const lastTopUpRow = driverVisibleRows.find((row) =>
      String(row.entry_type ?? "").toUpperCase() === COMMISSION_WALLET_ENTRY_TYPE.TOP_UP_CREDIT
    ) ?? null;

    const balanceStatus = resolveCommissionWalletBalanceStatus({
      balanceMinor: commissionWalletBalance,
      minimumBalanceMinor: minimumMinor,
    });

    const recentTransactions = driverVisibleRows.map((row) => {
      const meta = row.metadata && typeof row.metadata === "object"
        ? row.metadata as Record<string, unknown>
        : {};
      const providerTxn = String(
        meta.provider_transaction_id
          || meta.transaction_id
          || meta.topup_id
          || row.id
          || "",
      ).trim();
      const displayTxn = providerTxn
        ? (providerTxn.startsWith("TP-")
          ? providerTxn
          : `TP-${providerTxn.replace(/-/g, "").slice(0, 10).toUpperCase()}`)
        : null;
      return {
        id: row.id,
        entry_type: row.entry_type,
        amount_minor: row.amount_minor,
        direction: row.direction,
        currency: row.currency,
        reason: row.reason,
        created_at: row.created_at,
        // Privacy: no trip_id / commission fields on driver activity.
        trip_id: null,
        public_trip_id: null,
        credit_type: row.credit_type ?? null,
        transaction_type: meta.transaction_type ?? null,
        transaction_display_id: displayTxn,
        title: String(row.entry_type ?? "").toUpperCase() === COMMISSION_WALLET_ENTRY_TYPE.TOP_UP_CREDIT
          ? "Top up"
          : "Credit",
      };
    });

    let activeTopupBonus: Record<string, unknown> | null = null;
    if (serviceAreaId) {
      const { data: bonusCamps } = await supabase
        .from("commission_wallet_campaigns")
        .select(
          "id, campaign_name, campaign_type, currency, active, start_at, end_at, credit_amount_minor, bonus_percent, minimum_topup_amount_minor, maximum_bonus_amount_minor",
        )
        .eq("service_area_id", serviceAreaId)
        .eq("active", true)
        .in("campaign_type", ["TOP_UP_PERCENT_BONUS", "FIXED_TOP_UP_BONUS"])
        .limit(5);
      const bonus = (bonusCamps ?? []).find((c) =>
        isTopUpBonusCampaignType(c.campaign_type) && isCampaignActiveInWindow(c)
      );
      if (bonus) {
        activeTopupBonus = {
          campaign_id: bonus.id,
          campaign_name: bonus.campaign_name,
          campaign_type: bonus.campaign_type,
          currency: bonus.currency,
          credit_amount_minor: bonus.credit_amount_minor,
          bonus_percent: bonus.bonus_percent,
          minimum_topup_amount_minor: bonus.minimum_topup_amount_minor,
          maximum_bonus_amount_minor: bonus.maximum_bonus_amount_minor,
        };
      }
    }

    return json({
      success: true,
      page_visible: true,
      read_only: !topupEnabled,
      dispatch_enabled: dispatchGateApplies,
      dispatch_gate_applies: dispatchGateApplies,
      offer_eligibility_status: offerEligibilityStatus,
      offer_eligibility_reason: offerEligibilityReason,
      topup_enabled: topupEnabled,
      topup_provider: topupEnabled
        ? String(saConfig?.commission_topup_provider ?? "").toLowerCase() || null
        : null,
      withdraw_enabled: false,
      driver_id: driver.id,
      service_area_id: serviceAreaId,
      service_area_name: saConfig?.name ?? null,
      currency,
      minimum_balance_minor: minimumMinor,
      below_minimum: belowMinimum,
      balance_status: balanceStatus,
      balance_status_label:
        balanceStatus === "sufficient"
          ? "Sufficient balance"
          : balanceStatus === "low"
          ? "Low balance"
          : "Insufficient balance",
      commission_wallet_balance_minor: commissionWalletBalance,
      balance: commissionWalletBalance,
      total_topped_up_minor: totalToppedUpMinor,
      last_top_up: lastTopUpRow
        ? {
          amount_minor: Math.round(Number(lastTopUpRow.amount_minor) || 0),
          currency: String(lastTopUpRow.currency ?? currency).toUpperCase(),
          created_at: lastTopUpRow.created_at,
          id: lastTopUpRow.id,
        }
        : null,
      recent_transactions: recentTransactions,
      // Compat alias for existing detail page
      recent_ledger: recentTransactions,
      active_topup_bonus: activeTopupBonus,
      disclaimer: COMMISSION_WALLET_DRIVER_PAGE_DISCLAIMER,
      forbidden_actions: COMMISSION_WALLET_FORBIDDEN_ACTIONS,
    });
  } catch (err) {
    console.error("[driver-commission-wallet-summary]", err);
    return json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }, 500);
  }
});
