/**
 * Admin Commission Wallet campaigns CRUD — Phase 5.
 * Page-gated; never writes driver_wallet_ledger.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  requireAdminOrStaff,
  requirePageAccess,
  corsHeaders,
} from "../_shared/adminPaymentGate.ts";
import {
  COMMISSION_WALLET_CAMPAIGN_TYPE,
  isCommissionWalletWorkflowEnabled,
  isTopUpBonusCampaignType,
  validateCommissionWalletCampaignFields,
} from "../../../shared/commissionWalletSSOT.ts";

const PAGE_SLUG = "commission-wallet";

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const staffGate = await requireAdminOrStaff(req);
    if (!staffGate.ok) return staffGate.response;
    const gate = await requirePageAccess(staffGate, PAGE_SLUG);
    if (!gate.ok) return gate.response;

    if (gate.userId === "service-role" || !/^[0-9a-f-]{36}$/i.test(gate.userId)) {
      return json({
        success: false,
        error: "Authenticated admin/staff user required",
        code: "ADMIN_USER_REQUIRED",
      }, 403);
    }

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const op = String(body.op ?? "list").trim().toLowerCase();

    if (op === "list") {
      const serviceAreaId = String(body.service_area_id ?? "").trim();
      if (!serviceAreaId) {
        return json({ success: false, error: "service_area_id required" }, 400);
      }
      const { data, error } = await gate.supabase
        .from("commission_wallet_campaigns")
        .select("*")
        .eq("service_area_id", serviceAreaId)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) return json({ success: false, error: error.message }, 500);

      const ids = (data ?? []).map((c) => c.id);
      let claimCounts: Record<string, number> = {};
      if (ids.length) {
        const { data: claims } = await gate.supabase
          .from("commission_wallet_campaign_claims")
          .select("campaign_id")
          .in("campaign_id", ids);
        for (const row of claims ?? []) {
          const id = String(row.campaign_id);
          claimCounts[id] = (claimCounts[id] ?? 0) + 1;
        }
      }

      return json({
        success: true,
        phase: 5,
        campaigns: (data ?? []).map((c) => ({
          ...c,
          claim_count: claimCounts[c.id] ?? 0,
        })),
      });
    }

    if (op === "create" || op === "update") {
      const serviceAreaId = String(body.service_area_id ?? "").trim();
      const campaignId = String(body.campaign_id ?? "").trim();
      if (!serviceAreaId) {
        return json({ success: false, error: "service_area_id required" }, 400);
      }
      if (op === "update" && !campaignId) {
        return json({ success: false, error: "campaign_id required for update" }, 400);
      }

      const { data: sa, error: saErr } = await gate.supabase
        .from("service_areas")
        .select(
          "id, financial_model, commission_wallet_enabled, commission_wallet_currency, currency_code",
        )
        .eq("id", serviceAreaId)
        .maybeSingle();
      if (saErr || !sa) return json({ success: false, error: "Service area not found" }, 404);

      if (!isCommissionWalletWorkflowEnabled({
        financial_model: sa.financial_model,
        commission_wallet_enabled: sa.commission_wallet_enabled,
      })) {
        return json({
          success: false,
          error: "Commission Wallet not enabled for this service area",
          code: "WALLET_DISABLED",
        }, 400);
      }

      const walletCurrency = String(
        sa.commission_wallet_currency || sa.currency_code || "",
      ).toUpperCase();
      const currency = String(body.currency ?? walletCurrency).trim().toUpperCase();
      if (!currency || currency !== walletCurrency) {
        return json({
          success: false,
          error: "Campaign currency must match Commission Wallet currency",
          code: "CURRENCY_MISMATCH",
        }, 400);
      }

      const campaignType = String(body.campaign_type ?? "").trim().toUpperCase();
      const validTypes = Object.values(COMMISSION_WALLET_CAMPAIGN_TYPE);
      if (!(validTypes as string[]).includes(campaignType)) {
        return json({ success: false, error: "Invalid campaign_type" }, 400);
      }

      const campaignName = String(body.campaign_name ?? "").trim();
      if (!campaignName) {
        return json({ success: false, error: "campaign_name required" }, 400);
      }

      const active = body.active === true;
      const credit_amount_minor = Math.max(0, Math.round(Number(body.credit_amount_minor) || 0));
      const bonus_percent = body.bonus_percent == null ? null : Number(body.bonus_percent);
      const minimum_topup_amount_minor = Math.max(0, Math.round(Number(body.minimum_topup_amount_minor) || 0));
      const maximum_bonus_amount_minor = body.maximum_bonus_amount_minor == null
        ? null
        : Math.max(0, Math.round(Number(body.maximum_bonus_amount_minor) || 0));
      const start_at = body.start_at ? String(body.start_at) : null;
      const end_at = body.end_at ? String(body.end_at) : null;

      const fieldGate = validateCommissionWalletCampaignFields({
        campaignType,
        creditAmountMinor: credit_amount_minor,
        bonusPercent: bonus_percent,
        minimumTopupAmountMinor: minimum_topup_amount_minor,
        maximumBonusAmountMinor: maximum_bonus_amount_minor,
        startAt: start_at,
        endAt: end_at,
      });
      if (!fieldGate.ok) {
        return json({ success: false, error: fieldGate.error, code: fieldGate.code }, 400);
      }

      const row = {
        campaign_name: campaignName,
        service_area_id: serviceAreaId,
        currency,
        campaign_type: campaignType,
        credit_amount_minor,
        bonus_percent,
        minimum_topup_amount_minor,
        maximum_bonus_amount_minor,
        maximum_claims: body.maximum_claims == null
          ? null
          : Math.max(0, Math.round(Number(body.maximum_claims) || 0)),
        maximum_claims_per_driver: Math.max(
          1,
          Math.round(Number(body.maximum_claims_per_driver) || 1),
        ),
        eligible_driver_status: body.eligible_driver_status
          ? String(body.eligible_driver_status)
          : null,
        start_at,
        end_at,
        active,
        created_by: gate.userId,
      };

      if (isTopUpBonusCampaignType(campaignType) && active) {
        // Deactivate other active bonus campaigns for this SA first (one-active index).
        await gate.supabase
          .from("commission_wallet_campaigns")
          .update({ active: false })
          .eq("service_area_id", serviceAreaId)
          .eq("active", true)
          .in("campaign_type", [
            COMMISSION_WALLET_CAMPAIGN_TYPE.TOP_UP_PERCENT_BONUS,
            COMMISSION_WALLET_CAMPAIGN_TYPE.FIXED_TOP_UP_BONUS,
          ])
          .neq("id", campaignId || "00000000-0000-0000-0000-000000000000");
      }

      if (op === "create") {
        const { data, error } = await gate.supabase
          .from("commission_wallet_campaigns")
          .insert(row)
          .select("*")
          .single();
        if (error) return json({ success: false, error: error.message }, 400);
        return json({ success: true, phase: 5, campaign: data });
      }

      const { data, error } = await gate.supabase
        .from("commission_wallet_campaigns")
        .update({
          campaign_name: row.campaign_name,
          currency: row.currency,
          campaign_type: row.campaign_type,
          credit_amount_minor: row.credit_amount_minor,
          bonus_percent: row.bonus_percent,
          minimum_topup_amount_minor: row.minimum_topup_amount_minor,
          maximum_bonus_amount_minor: row.maximum_bonus_amount_minor,
          maximum_claims: row.maximum_claims,
          maximum_claims_per_driver: row.maximum_claims_per_driver,
          eligible_driver_status: row.eligible_driver_status,
          start_at: row.start_at,
          end_at: row.end_at,
          active: row.active,
        })
        .eq("id", campaignId)
        .eq("service_area_id", serviceAreaId)
        .select("*")
        .maybeSingle();
      if (error) return json({ success: false, error: error.message }, 400);
      if (!data) return json({ success: false, error: "Campaign not found" }, 404);
      return json({ success: true, phase: 5, campaign: data });
    }

    if (op === "deactivate") {
      const campaignId = String(body.campaign_id ?? "").trim();
      if (!campaignId) return json({ success: false, error: "campaign_id required" }, 400);
      const { data, error } = await gate.supabase
        .from("commission_wallet_campaigns")
        .update({ active: false })
        .eq("id", campaignId)
        .select("*")
        .maybeSingle();
      if (error) return json({ success: false, error: error.message }, 400);
      if (!data) return json({ success: false, error: "Campaign not found" }, 404);
      return json({ success: true, phase: 5, campaign: data });
    }

    return json({ success: false, error: "Unknown op" }, 400);
  } catch (e) {
    console.error("admin-commission-wallet-campaigns", e);
    return json({
      success: false,
      error: e instanceof Error ? e.message : "Internal error",
    }, 500);
  }
});
