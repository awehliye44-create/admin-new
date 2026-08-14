/**
 * Driver Commission Wallet initiate top-up — Phase 4 sandbox.
 * Creates topup row, Waafi sandbox payment, auto-confirms TOP_UP_CREDIT.
 * Never writes driver_wallet_ledger.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { resolveDriverServiceAreaId } from "../_shared/resolveDriverServiceAreaId.ts";
import { confirmCommissionWalletTopupCredit } from "../_shared/commissionWalletTopupConfirm.ts";
import { createWaafiSandboxPayment } from "../_shared/commissionWalletProviders/waafiSandboxAdapter.ts";
import {
  COMMISSION_TOPUP_STATUS,
  COMMISSION_WALLET_FORBIDDEN_ACTIONS,
  buildCommissionWalletTopupIdempotencyKey,
  deriveBalancesFromCommissionLedgerEntries,
  isCommissionWalletWorkflowEnabled,
  planCommissionWalletTopupInitiate,
  planDriverCommissionWalletPageAccess,
  shouldEnableDriverCommissionWalletTopup,
  validateDriverCommissionWalletServiceAreaAssignment,
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

    const body = await req.json().catch(() => ({})) as {
      amount_minor?: number;
      currency?: string;
      client_key?: string;
      idempotency_key?: string;
    };

    const amountMinor = Math.round(Number(body.amount_minor) || 0);
    const clientKey = String(body.client_key ?? body.idempotency_key ?? crypto.randomUUID()).trim();

    const { data: driver, error: driverError } = await supabase
      .from("drivers")
      .select("id, service_area_id, commission_wallet_test_access, region_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (driverError || !driver) {
      return json({ success: false, error: "Driver not found" }, 404);
    }

    const serviceAreaId = await resolveDriverServiceAreaId(
      supabase,
      driver.id,
      driver.service_area_id,
    );
    if (!serviceAreaId) {
      return json({ success: false, error: "Driver has no service area", code: "NO_SERVICE_AREA" }, 400);
    }

    const assigned = Boolean(serviceAreaId)
      && (!driver.service_area_id || driver.service_area_id === serviceAreaId);
    const assignment = validateDriverCommissionWalletServiceAreaAssignment({
      driverAssignedToServiceArea: assigned,
    });
    if (!assignment.ok) {
      return json({ success: false, error: assignment.error, code: assignment.code }, 400);
    }

    const { data: sa, error: saErr } = await supabase
      .from("service_areas")
      .select(
        "id, region_id, name, financial_model, commission_wallet_enabled, commission_wallet_currency, commission_topup_provider, commission_wallet_topup_enabled, currency_code",
      )
      .eq("id", serviceAreaId)
      .maybeSingle();

    if (saErr || !sa) {
      return json({ success: false, error: "Service area not found" }, 404);
    }

    const walletEnabled = isCommissionWalletWorkflowEnabled({
      financial_model: sa.financial_model,
      commission_wallet_enabled: sa.commission_wallet_enabled,
    });
    const walletCurrency = String(
      sa.commission_wallet_currency || sa.currency_code || "USD",
    ).toUpperCase();
    const currency = String(body.currency ?? walletCurrency).trim().toUpperCase();

    const access = planDriverCommissionWalletPageAccess({
      config: {
        financial_model: sa.financial_model,
        commission_wallet_enabled: sa.commission_wallet_enabled,
      },
      commissionWalletTestAccess: true,
      hasServiceArea: true,
    });
    if (!access.ok) {
      return json({
        success: false,
        error: access.error,
        code: access.code,
        page_visible: false,
      }, 403);
    }

    const plan = planCommissionWalletTopupInitiate({
      walletEnabled,
      topupEnabled: sa.commission_wallet_topup_enabled === true,
      provider: sa.commission_topup_provider,
      amountMinor,
      currency,
      walletCurrency,
    });
    if (!plan.ok) {
      return json({ success: false, error: plan.error, code: plan.code }, 400);
    }

    const idempotencyKey = buildCommissionWalletTopupIdempotencyKey({
      driverId: driver.id,
      serviceAreaId,
      amountMinor: plan.amount_minor,
      clientKey,
    });

    // Idempotent replay of same client key
    const { data: existing } = await supabase
      .from("driver_commission_wallet_topups")
      .select("id, status, amount_minor, currency, provider, provider_transaction_id, credited_ledger_entry_id")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    if (existing?.status === COMMISSION_TOPUP_STATUS.SUCCEEDED) {
      const balances = await loadBalances(supabase, driver.id, serviceAreaId);
      return json({
        success: true,
        phase: 4,
        idempotent: true,
        sandbox: true,
        auto_confirmed: true,
        topup: existing,
        balances,
        topup_enabled: shouldEnableDriverCommissionWalletTopup({
          config: {
            financial_model: sa.financial_model,
            commission_wallet_enabled: sa.commission_wallet_enabled,
            commission_topup_provider: sa.commission_topup_provider,
            commission_wallet_topup_enabled: sa.commission_wallet_topup_enabled === true,
          },
        }),
        forbidden_actions: COMMISSION_WALLET_FORBIDDEN_ACTIONS,
      });
    }

    let topupId = existing?.id as string | undefined;
    if (!topupId) {
      const { data: inserted, error: insertErr } = await supabase
        .from("driver_commission_wallet_topups")
        .insert({
          driver_id: driver.id,
          service_area_id: serviceAreaId,
          region_id: sa.region_id ?? driver.region_id ?? null,
          currency: plan.currency,
          amount_minor: plan.amount_minor,
          provider: plan.provider,
          status: COMMISSION_TOPUP_STATUS.PENDING,
          idempotency_key: idempotencyKey,
          metadata: { phase: 4, sandbox: true, client_key: clientKey },
        })
        .select("id, status, amount_minor, currency, provider")
        .single();

      if (insertErr) {
        const { data: raced } = await supabase
          .from("driver_commission_wallet_topups")
          .select("id, status, amount_minor, currency, provider, provider_transaction_id, credited_ledger_entry_id")
          .eq("idempotency_key", idempotencyKey)
          .maybeSingle();
        if (raced?.status === COMMISSION_TOPUP_STATUS.SUCCEEDED) {
          const balances = await loadBalances(supabase, driver.id, serviceAreaId);
          return json({
            success: true,
            phase: 4,
            idempotent: true,
            sandbox: true,
            auto_confirmed: true,
            topup: raced,
            balances,
            forbidden_actions: COMMISSION_WALLET_FORBIDDEN_ACTIONS,
          });
        }
        if (!raced?.id) {
          return json({ success: false, error: insertErr.message }, 500);
        }
        topupId = raced.id;
      } else {
        topupId = inserted!.id;
      }
    }

    const payment = createWaafiSandboxPayment({
      amountMinor: plan.amount_minor,
      currency: plan.currency,
      topupId: topupId!,
      idempotencyKey,
    });

    const { error: procErr } = await supabase
      .from("driver_commission_wallet_topups")
      .update({
        status: COMMISSION_TOPUP_STATUS.PROCESSING,
        provider_transaction_id: payment.provider_transaction_id,
        updated_at: new Date().toISOString(),
        metadata: {
          phase: 4,
          sandbox: true,
          client_key: clientKey,
          provider_status: payment.status,
        },
      })
      .eq("id", topupId!);

    if (procErr) {
      return json({ success: false, error: procErr.message }, 500);
    }

    // Sandbox automatic confirmation (same path as webhook).
    const confirm = await confirmCommissionWalletTopupCredit(supabase, {
      topupId: topupId!,
      provider: payment.provider,
      providerTransactionId: payment.provider_transaction_id,
      confirmedAmountMinor: plan.amount_minor,
      confirmedCurrency: plan.currency,
    });

    if (!confirm.ok) {
      await supabase
        .from("driver_commission_wallet_topups")
        .update({
          status: COMMISSION_TOPUP_STATUS.FAILED,
          updated_at: new Date().toISOString(),
          metadata: { phase: 4, sandbox: true, confirm_error: confirm.error },
        })
        .eq("id", topupId!);
      return json({
        success: false,
        error: confirm.error,
        code: confirm.code,
      }, confirm.status ?? 500);
    }

    const { data: topupRow } = await supabase
      .from("driver_commission_wallet_topups")
      .select("id, status, amount_minor, currency, provider, provider_transaction_id, credited_ledger_entry_id, created_at")
      .eq("id", topupId!)
      .maybeSingle();

    const balances = await loadBalances(supabase, driver.id, serviceAreaId);

    return json({
      success: true,
      phase: 5,
      idempotent: confirm.already_succeeded,
      sandbox: true,
      auto_confirmed: true,
      topup: topupRow,
      ledger_entry_id: confirm.ledger_entry_id,
      bonus: confirm.bonus ?? null,
      balances,
      topup_enabled: true,
      forbidden_actions: COMMISSION_WALLET_FORBIDDEN_ACTIONS,
    });
  } catch (err) {
    console.error("[driver-commission-wallet-initiate-topup]", err);
    return json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }, 500);
  }
});

async function loadBalances(
  supabase: ReturnType<typeof createClient>,
  driverId: string,
  serviceAreaId: string,
) {
  const { data: rows } = await supabase
    .from("driver_commission_wallet_ledger")
    .select("entry_type, amount_minor, direction, promotional_portion_minor, purchased_portion_minor")
    .eq("driver_id", driverId)
    .eq("service_area_id", serviceAreaId)
    .order("created_at", { ascending: true })
    .limit(10000);
  return deriveBalancesFromCommissionLedgerEntries(rows ?? []);
}
