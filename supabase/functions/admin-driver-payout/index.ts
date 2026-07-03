import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveCurrencyFromDriver } from "../_shared/regionCurrency.ts";
import { finalizePayoutAfterProviderSuccess } from "../_shared/payoutLedgerSync.ts";
import {
  buildPayoutSettlementSnapshot,
  recordPayoutFailureAndReturnToWallet,
  recordPayoutSuccessDiagnostics,
} from "../_shared/payoutFailureRecovery.ts";
import { fetchPerDriverFinancialReconciliation } from "../_shared/perDriverFinancialReconciliation.ts";
import { derivePayoutEligibility } from "../_shared/onecabFinanceLedger.ts";
import { findInFlightPayoutItem } from "../_shared/payoutInflightGuard.ts";
import {
  evaluatePayoutGuard,
  WALLET_NEGATIVE_BLOCK_CODE,
  PAYOUT_EXCEEDS_AVAILABLE_BLOCK_CODE,
} from "../_shared/payoutAvailability.ts";
import {
  isAdminStripePayoutExecutionEnabled,
  isPayoutVerificationMode,
  PAYOUT_EXECUTION_DISABLED_CODE,
  PAYOUT_EXECUTION_DISABLED_MESSAGE,
  PAYOUT_VERIFICATION_MODE_MESSAGE,
} from "../_shared/payoutExecutionGate.ts";
import {
  assertPayoutRetryAllowed,
  readPlatformAvailablePence,
} from "../_shared/payoutRetryGuard.ts";
import { fetchDriverWalletPayoutSnapshot } from "../_shared/fetchDriverWalletPayoutSnapshot.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MANUAL_PAYOUT_NO_SSOT_BALANCE_MESSAGE =
  "Manual payout unavailable. Driver has no positive SSOT available balance after cash commission recovery.";

function formatPayoutEligibilityLabel(args: {
  stripe_connected: boolean;
  payout_eligible: boolean;
  payout_blocked: boolean;
  available_now_pence: number;
  has_soft_warning?: boolean;
}): string {
  if (!args.stripe_connected) return "Not Connected";
  if (!args.payout_eligible) return "Connected — Payout Not Enabled";
  if (args.payout_blocked) return "Blocked — Payout Hold";
  if (args.available_now_pence <= 0) return "Connected — No SSOT Available Balance";
  if (args.has_soft_warning) return "Eligible — Finance Review Warning";
  return "Eligible";
}

async function fetchDriverFinanceSnapshot(
  supabase: ReturnType<typeof createClient>,
  driverId: string,
) {
  const { data } = await supabase
    .from("driver_financial_summary")
    .select("amount_owed_to_onecab, card_net_credits")
    .eq("driver_id", driverId)
    .maybeSingle();

  return {
    amount_owed_to_onecab: Number(data?.amount_owed_to_onecab ?? 0),
    settled_card_earnings_pence: Number(data?.card_net_credits ?? 0),
  };
}

function manualPayoutBlockedResponse(args: {
  error: string;
  error_code: string;
  status: number;
  ssot: Record<string, unknown>;
  payout_blocked_reasons?: string[];
}) {
  return new Response(JSON.stringify({
    success: false,
    error: args.error,
    error_code: args.error_code,
    payout_blocked_reasons: args.payout_blocked_reasons ?? [],
    ssot: args.ssot,
  }), {
    status: args.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * admin-driver-payout
 *
 * Pays out from the driver's wallet balance to their Stripe connected account.
 * Completion requires: provider transfer succeeds → ledger debit → wallet recalc.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY');
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: roleData } = await supabase
      .from('user_roles').select('role')
      .eq('user_id', user.id).eq('role', 'admin').maybeSingle();

    if (!roleData) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json();
    const verificationMode = isPayoutVerificationMode(body as Record<string, unknown>);
    const stripeExecutionEnabled = isAdminStripePayoutExecutionEnabled();

    // Phase 3D.1 — exit before any payout writes or Stripe calls
    if (verificationMode) {
      const previewDriverId = body.driver_id as string | undefined;
      if (!previewDriverId) {
        return new Response(JSON.stringify({ error: 'driver_id is required' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const amount_pence_preview = body.amount_pence as number | undefined;
      const { data: previewDriver } = await supabase
        .from('drivers')
        .select('id, region_id')
        .eq('id', previewDriverId)
        .single();
      if (!previewDriver) {
        return new Response(JSON.stringify({ error: 'Driver not found' }), {
          status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const currencyResultPreview = await resolveCurrencyFromDriver(supabase, previewDriverId);
      const currency_code_preview = currencyResultPreview.currency_code;
      const ssotPreview = await fetchPerDriverFinancialReconciliation(supabase, {
        driverId: previewDriverId,
        providerAvailableBalancePence: 0,
        providerPendingBalancePence: 0,
        sourceTier: 'LIVE',
      });
      const availablePreview = ssotPreview.driver_available_now_pence;
      const payoutAmountPreview = amount_pence_preview || availablePreview;
      const financePreview = await fetchDriverFinanceSnapshot(supabase, previewDriverId);
      const runDatePreview = new Date().toISOString().slice(0, 10);
      const settlementSnapshotPreview = payoutAmountPreview > 0
        ? await buildPayoutSettlementSnapshot(supabase, previewDriverId, payoutAmountPreview, runDatePreview)
        : {
          gross_payable_pence: 0,
          cash_commission_recovered_pence: 0,
          net_driver_payout_pence: 0,
        };

      return new Response(JSON.stringify({
        success: true,
        dry_run: true,
        verification_mode: true,
        payout_safety_version: '3d.1',
        stripe_execution_disabled: !stripeExecutionEnabled,
        amount: payoutAmountPreview,
        payout_warning_reasons: ssotPreview.payout_warning_reasons,
        payout_blocked_reasons: ssotPreview.payout_blocked_reasons,
        settlement_status: 'SIMULATED',
        gross_payable_pence: settlementSnapshotPreview.gross_payable_pence,
        cash_commission_recovered_pence: settlementSnapshotPreview.cash_commission_recovered_pence,
        net_driver_payout_pence: settlementSnapshotPreview.net_driver_payout_pence,
        wallet_balance_before: availablePreview,
        currency_code: currency_code_preview,
        message: PAYOUT_VERIFICATION_MODE_MESSAGE,
        ssot: {
          driver_available_now_pence: availablePreview,
          outstanding_cash_commission_pence: financePreview.amount_owed_to_onecab,
          settled_card_earnings_pence: financePreview.settled_card_earnings_pence,
          reconciliation_status: ssotPreview.reconciliation_status,
        },
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let driver_id = body.driver_id as string | undefined;
    let amount_pence = body.amount_pence as number | undefined;
    let kind = (body.kind as string | undefined) ?? 'MANUAL_ADMIN';
    const payout_item_id = body.payout_item_id as string | undefined;
    const retry_payout_item_id = body.retry_payout_item_id as string | undefined;
    const confirm_payout = body.confirm_payout === true;
    let reusePayoutItem: Record<string, unknown> | null = null;
    let reuseBatchId: string | null = null;

    // Retry ledger sync for existing payout item (provider already paid)
    if (payout_item_id && !retry_payout_item_id) {
      const { data: syncResult, error: syncError } = await supabase.rpc(
        'sync_payout_item_ledger_debit',
        { p_payout_item_id: payout_item_id },
      );
      if (syncError) throw syncError;
      return new Response(JSON.stringify({
        success: (syncResult as { success?: boolean })?.success ?? false,
        retry: true,
        result: syncResult,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Full provider retry requires live Stripe execution
    if (retry_payout_item_id) {
      if (!stripeExecutionEnabled) {
        return new Response(JSON.stringify({
          success: false,
          error: PAYOUT_EXECUTION_DISABLED_MESSAGE,
          error_code: PAYOUT_EXECUTION_DISABLED_CODE,
        }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (!confirm_payout) {
        return new Response(JSON.stringify({
          error: 'confirm_payout is required to retry a failed payout',
          error_code: 'MANUAL_PAYOUT_CONFIRMATION_REQUIRED',
        }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { data: existingItem, error: itemLoadError } = await supabase
        .from('payout_items')
        .select('*, payout_batches(kind)')
        .eq('id', retry_payout_item_id)
        .single();

      if (itemLoadError || !existingItem) {
        return new Response(JSON.stringify({ error: 'Payout item not found' }), {
          status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (existingItem.stripe_transfer_id) {
        return new Response(JSON.stringify({
          error: 'Payout item already has a provider transfer — use ledger sync retry only',
          error_code: 'PAYOUT_RETRY_DUPLICATE_GUARD',
        }), {
          status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (existingItem.status !== 'failed') {
        return new Response(JSON.stringify({
          error: 'Only failed payout items without provider transfer can be retried',
          error_code: 'PAYOUT_RETRY_NOT_ELIGIBLE',
        }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const retryDriverId = existingItem.driver_id as string;
      const inflight = await findInFlightPayoutItem(supabase, retryDriverId, retry_payout_item_id);
      if (inflight) {
        return new Response(JSON.stringify({
          error: 'Another payout is in flight for this driver',
          error_code: 'PAYOUT_IN_FLIGHT',
          in_flight_payout_item_id: inflight.id,
        }), {
          status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const retryAmount = Number(existingItem.net_driver_payout_pence ?? existingItem.amount_pence);
      if (!stripeSecretKey) {
        return new Response(JSON.stringify({
          success: false,
          error: "Stripe not configured",
          error_code: "STRIPE_NOT_CONFIGURED",
        }), {
          status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });
      const currencyResultRetry = await resolveCurrencyFromDriver(supabase, retryDriverId);
      const { data: retryDriver } = await supabase
        .from("drivers")
        .select("stripe_account_id, payouts_enabled, charges_enabled")
        .eq("id", retryDriverId)
        .maybeSingle();
      const walletSnap = await fetchDriverWalletPayoutSnapshot(supabase, {
        driverId: retryDriverId,
        stripe,
        currency: currencyResultRetry.currency_code,
      });
      const retryGuard = await assertPayoutRetryAllowed({
        stripe,
        currency: currencyResultRetry.currency_code,
        requiredAmountPence: retryAmount,
        payoutItem: existingItem,
        driver: retryDriver,
        walletOwedPence: walletSnap.current_onecab_wallet_owed_pence,
        localOnlyApproved: Boolean(body.approve_local_only_retry ?? confirm_payout),
      });
      if (!retryGuard.ok) {
        const platformAvailable = await readPlatformAvailablePence(
          stripe,
          currencyResultRetry.currency_code,
        );
        return new Response(JSON.stringify({
          success: false,
          error: retryGuard.message,
          error_code: retryGuard.code,
          platform_available_pence: platformAvailable,
          required_amount_pence: retryAmount,
        }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Fall through to shared payout path using existing item
      driver_id = retryDriverId;
      amount_pence = Number(existingItem.net_driver_payout_pence ?? existingItem.amount_pence);
      kind = (existingItem.payout_batches as { kind?: string } | null)?.kind ?? kind;
      reusePayoutItem = existingItem;
      reuseBatchId = existingItem.batch_id as string;
    }

    if (!driver_id) {
      return new Response(JSON.stringify({ error: 'driver_id is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let currency_code: string;
    try {
      const regionCurrency = await resolveCurrencyFromDriver(supabase, driver_id);
      currency_code = regionCurrency.currency_code;
    } catch (e) {
      console.error('[payout] Currency resolution failed:', e);
      return new Response(JSON.stringify({ error: (e as Error).message, error_code: 'REGION_CURRENCY_UNRESOLVABLE' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: driver, error: driverError } = await supabase
      .from('drivers')
      .select('id, first_name, last_name, service_area_id, stripe_account_id, payouts_enabled, onboarding_complete, charges_enabled')
      .eq('id', driver_id).single();

    if (driverError || !driver) {
      return new Response(JSON.stringify({ error: 'Driver not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let driverPayoutGateway = 'stripe';
    if (driver.service_area_id) {
      const { data: serviceAreaRow } = await supabase
        .from('service_areas')
        .select('driver_payout_gateway')
        .eq('id', driver.service_area_id)
        .maybeSingle();
      driverPayoutGateway = (serviceAreaRow?.driver_payout_gateway as string | null) ?? 'stripe';
    }

    if (driverPayoutGateway !== 'stripe') {
      const { data: activeDestination } = await supabase
        .from('driver_payout_destinations')
        .select('id, destination_label, destination_last4')
        .eq('driver_id', driver_id)
        .eq('provider', driverPayoutGateway)
        .eq('is_active', true)
        .is('archived_at', null)
        .maybeSingle();

      if (!activeDestination?.id) {
        return manualPayoutBlockedResponse({
          error: 'Payout destination is not configured. Please add a payout destination to receive weekly payouts.',
          error_code: 'PAYOUT_DESTINATION_NOT_CONFIGURED',
          status: 400,
          ssot: { driver_payout_gateway: driverPayoutGateway },
        });
      }

      return manualPayoutBlockedResponse({
        error: `${driverPayoutGateway} payout execution is not yet enabled (PROVIDER_NOT_IMPLEMENTED).`,
        error_code: 'PROVIDER_NOT_IMPLEMENTED',
        status: 400,
        ssot: {
          driver_payout_gateway: driverPayoutGateway,
          masked_destination: activeDestination.destination_label,
        },
      });
    }

    let externalAccountExists = true;
    let requirementsCurrentlyDue: string[] = [];
    if (stripeSecretKey && driver.stripe_account_id) {
      try {
        const stripe = new Stripe(stripeSecretKey, { apiVersion: '2023-10-16' });
        const account = await stripe.accounts.retrieve(driver.stripe_account_id);
        externalAccountExists = Boolean(account.external_accounts?.data?.length);
        requirementsCurrentlyDue = account.requirements?.currently_due ?? [];
      } catch (stripeAcctErr) {
        console.warn('[payout] Stripe account lookup failed:', stripeAcctErr);
      }
    }

    const payoutEligibility = derivePayoutEligibility({
      stripe_account_id: driver.stripe_account_id,
      payouts_enabled: driver.payouts_enabled,
      charges_enabled: driver.charges_enabled,
      onboarding_complete: driver.onboarding_complete,
      external_account_exists: externalAccountExists,
      requirements_currently_due: requirementsCurrentlyDue,
    });

    if (!payoutEligibility.payout_eligible) {
      const finance = await fetchDriverFinanceSnapshot(supabase, driver_id);
      return manualPayoutBlockedResponse({
        error: payoutEligibility.stripe_connected
          ? "Payout account needs attention"
          : "Driver payout account not eligible",
        error_code: "MANUAL_PAYOUT_NOT_ELIGIBLE",
        status: 400,
        ssot: {
          driver_available_now_pence: 0,
          outstanding_cash_commission_pence: finance.amount_owed_to_onecab,
          settled_card_earnings_pence: finance.settled_card_earnings_pence,
          payout_eligibility: payoutEligibility,
          payout_eligibility_status: formatPayoutEligibilityLabel({
            stripe_connected: payoutEligibility.stripe_connected,
            payout_eligible: false,
            payout_blocked: true,
            available_now_pence: 0,
          }),
        },
      });
    }

    let stripeAvailablePence = 0;
    let stripePendingPence = 0;
    if (!verificationMode && stripeSecretKey) {
      const stripe = new Stripe(stripeSecretKey, { apiVersion: '2023-10-16' });
      const balance = await stripe.balance.retrieve();
      stripeAvailablePence = balance.available.find((b) => b.currency === 'gbp')?.amount ?? 0;
      stripePendingPence = balance.pending.find((b) => b.currency === 'gbp')?.amount ?? 0;
    }

    const ssot = await fetchPerDriverFinancialReconciliation(supabase, {
      driverId: driver_id,
      providerAvailableBalancePence: stripeAvailablePence,
      providerPendingBalancePence: stripePendingPence,
      sourceTier: 'LIVE',
    });

    if (ssot.payout_blocked) {
      const finance = await fetchDriverFinanceSnapshot(supabase, driver_id);
      return manualPayoutBlockedResponse({
        error: 'Payout blocked by financial reconciliation',
        error_code: 'MANUAL_PAYOUT_BLOCKED',
        status: 400,
        ssot: {
          driver_available_now_pence: ssot.driver_available_now_pence,
          outstanding_cash_commission_pence: finance.amount_owed_to_onecab,
          settled_card_earnings_pence: finance.settled_card_earnings_pence,
          reconciliation_status: ssot.reconciliation_status,
          payout_warning_reasons: ssot.payout_warning_reasons,
          payout_eligibility_status: formatPayoutEligibilityLabel({
            stripe_connected: payoutEligibility.stripe_connected,
            payout_eligible: payoutEligibility.payout_eligible,
            payout_blocked: true,
            available_now_pence: ssot.driver_available_now_pence,
            has_soft_warning: ssot.payout_warning_reasons.length > 0,
          }),
        },
        payout_blocked_reasons: ssot.payout_blocked_reasons,
      });
    }

    if (!reusePayoutItem) {
      const inflight = await findInFlightPayoutItem(supabase, driver_id);
      if (inflight) {
        return new Response(JSON.stringify({
          success: false,
          error: 'A payout is already in flight for this driver',
          error_code: 'PAYOUT_IN_FLIGHT',
          in_flight_payout_item_id: inflight.id,
          ssot: { driver_available_now_pence: ssot.driver_available_now_pence },
        }), {
          status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    if (!confirm_payout) {
      const finance = await fetchDriverFinanceSnapshot(supabase, driver_id);
      return new Response(JSON.stringify({
        success: false,
        error: 'confirm_payout is required before executing payout',
        error_code: 'MANUAL_PAYOUT_CONFIRMATION_REQUIRED',
        payout_warning_reasons: ssot.payout_warning_reasons,
        payout_blocked_reasons: ssot.payout_blocked_reasons,
        ssot: {
          driver_available_now_pence: ssot.driver_available_now_pence,
          outstanding_cash_commission_pence: finance.amount_owed_to_onecab,
          settled_card_earnings_pence: finance.settled_card_earnings_pence,
          reconciliation_status: ssot.reconciliation_status,
          provider_allocated_pence: ssot.provider_available_balance_allocated_to_driver_pence,
        },
      }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const available = ssot.eligible_payout_pence ?? ssot.driver_available_now_pence;
    const walletBalance = ssot.driver_wallet_balance_pence;
    const payoutAmount = amount_pence || available;

    console.log(
      `[payout] Driver ${driver_id}: wallet_balance=${walletBalance}p, ` +
      `eligible_payout=${available}p, finance_cleared=${ssot.finance_cleared_amount_pence}p, ` +
      `debt=${ssot.driver_debt_pence}p, requested=${payoutAmount}p, currency=${currency_code}`,
    );

    // P1 SSOT guard — wallet<0 blocks; requested>eligible blocks.
    const guard = evaluatePayoutGuard({
      walletBalancePence: walletBalance,
      requestedPence: payoutAmount,
      financeClearedPence: ssot.finance_cleared_amount_pence,
      stripeSettledUnpaidPence: ssot.provider_available_balance_allocated_to_driver_pence,
      inFlightPayoutPence: ssot.in_flight_cashout_pence,
      payoutBlocked: ssot.payout_blocked,
    });
    if (!guard.allowed) {
      const finance = await fetchDriverFinanceSnapshot(supabase, driver_id);
      const isWalletNegative = guard.block_codes.includes(WALLET_NEGATIVE_BLOCK_CODE);
      const errorCode = isWalletNegative
        ? WALLET_NEGATIVE_BLOCK_CODE
        : PAYOUT_EXCEEDS_AVAILABLE_BLOCK_CODE;
      return manualPayoutBlockedResponse({
        error: guard.block_reasons.join(" "),
        error_code: errorCode,
        status: 400,
        ssot: {
          driver_wallet_balance_pence: walletBalance,
          driver_debt_pence: guard.driver_debt_pence,
          driver_available_now_pence: guard.available_payout_pence,
          requested_pence: payoutAmount,
          outstanding_cash_commission_pence: finance.amount_owed_to_onecab,
          settled_card_earnings_pence: finance.settled_card_earnings_pence,
          reconciliation_status: ssot.reconciliation_status,
        },
        payout_blocked_reasons: guard.block_reasons,
      });
    }

    if (payoutAmount <= 0) {
      const finance = await fetchDriverFinanceSnapshot(supabase, driver_id);
      return manualPayoutBlockedResponse({
        error: MANUAL_PAYOUT_NO_SSOT_BALANCE_MESSAGE,
        error_code: 'MANUAL_PAYOUT_NO_SSOT_BALANCE',
        status: 400,
        ssot: {
          driver_wallet_balance_pence: walletBalance,
          driver_debt_pence: ssot.driver_debt_pence,
          driver_available_now_pence: available,
          outstanding_cash_commission_pence: finance.amount_owed_to_onecab,
          settled_card_earnings_pence: finance.settled_card_earnings_pence,
          reconciliation_status: ssot.reconciliation_status,
          payout_eligibility: payoutEligibility,
          payout_eligibility_status: formatPayoutEligibilityLabel({
            stripe_connected: payoutEligibility.stripe_connected,
            payout_eligible: payoutEligibility.payout_eligible,
            payout_blocked: ssot.payout_blocked,
            available_now_pence: available,
            has_soft_warning: ssot.payout_warning_reasons.length > 0,
          }),
        },
        payout_blocked_reasons: ssot.payout_blocked_reasons,
      });
    }

    if (!driver.stripe_account_id) {
      return new Response(JSON.stringify({ error: 'Driver has no connected Stripe account' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!stripeExecutionEnabled) {
      const finance = await fetchDriverFinanceSnapshot(supabase, driver_id);
      const runDate = new Date().toISOString().slice(0, 10);
      const settlementSnapshot = await buildPayoutSettlementSnapshot(
        supabase,
        driver_id,
        payoutAmount,
        runDate,
      );

      return new Response(JSON.stringify({
        success: true,
        dry_run: true,
        stripe_execution_disabled: true,
        amount: payoutAmount,
        payout_warning_reasons: ssot.payout_warning_reasons,
        payout_blocked_reasons: ssot.payout_blocked_reasons,
        settlement_status: 'SIMULATED',
        gross_payable_pence: settlementSnapshot.gross_payable_pence,
        cash_commission_recovered_pence: settlementSnapshot.cash_commission_recovered_pence,
        net_driver_payout_pence: settlementSnapshot.net_driver_payout_pence,
        wallet_balance_before: available,
        currency_code,
        message: PAYOUT_EXECUTION_DISABLED_MESSAGE,
        error_code: PAYOUT_EXECUTION_DISABLED_CODE,
        ssot: {
          driver_available_now_pence: available,
          outstanding_cash_commission_pence: finance.amount_owed_to_onecab,
          settled_card_earnings_pence: finance.settled_card_earnings_pence,
          reconciliation_status: ssot.reconciliation_status,
        },
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let batch: { id: string; run_date?: string | null };
    let payoutItem: { id: string };

    if (reusePayoutItem && reuseBatchId) {
      batch = { id: reuseBatchId, run_date: null };
      payoutItem = { id: reusePayoutItem.id as string };
      await supabase.from('payout_items').update({
        status: 'pending',
        settlement_status: 'PROCESSING',
        failure_code: null,
        failure_reason: null,
        provider_response: {
          payout_warning_reasons: ssot.payout_warning_reasons,
          payout_blocked_reasons: ssot.payout_blocked_reasons,
          retry_at: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      }).eq('id', payoutItem.id);
    } else {
      const { data: newBatch, error: batchError } = await supabase
        .from('payout_batches')
        .insert({
          kind,
          status: 'CREATED',
          total_drivers: 1,
          total_amount_pence: 0,
          created_by: user.id,
        })
        .select().single();

      if (batchError) throw batchError;
      batch = newBatch;

      const { data: newItem, error: itemError } = await supabase
        .from('payout_items')
        .insert({
          batch_id: batch.id,
          driver_id,
          amount_pence: payoutAmount,
          status: 'pending',
          settlement_status: 'CREATED',
          provider_response: {
            payout_warning_reasons: ssot.payout_warning_reasons,
            payout_blocked_reasons: ssot.payout_blocked_reasons,
          },
        })
        .select().single();

      if (itemError || !newItem) {
        await supabase.from('payout_batches').update({
          status: 'INVALID_ORPHANED',
          failure_code: 'ORPHANED_NO_ITEMS',
          failure_reason: 'Batch has amount but no payout items',
          failed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', batch.id);
        throw itemError ?? new Error('payout_item insert failed');
      }
      payoutItem = newItem;

      await supabase.from('payout_batches').update({
        total_amount_pence: payoutAmount,
        status: 'READY',
        updated_at: new Date().toISOString(),
      }).eq('id', batch.id);

      await supabase.from('driver_wallet_ledger').insert({
        driver_id,
        type: 'PAYOUT_CREATED',
        amount_pence: 0,
        currency: currency_code,
        description: `Payout batch ${batch.id} created (${kind})`,
      });
    }

    const runDate = batch.run_date ?? new Date().toISOString().slice(0, 10);
    const settlementSnapshot = await buildPayoutSettlementSnapshot(
      supabase,
      driver_id,
      payoutAmount,
      runDate,
    );

    await supabase.from('payout_items').update({
      settlement_status: 'PROCESSING',
      gross_payable_pence: settlementSnapshot.gross_payable_pence,
      cash_commission_recovered_pence: settlementSnapshot.cash_commission_recovered_pence,
      net_driver_payout_pence: settlementSnapshot.net_driver_payout_pence,
      updated_at: new Date().toISOString(),
    }).eq('id', payoutItem.id);

    let stripeTransferId: string | null = null;
    let stripePayoutId: string | null = null;
    let stripeError: string | null = null;

    if (stripeSecretKey) {
      try {
        const stripe = new Stripe(stripeSecretKey, { apiVersion: '2023-10-16' });
        const idempotencyKey = `payout_${payoutItem.id}`;

        const transfer = await stripe.transfers.create({
          amount: payoutAmount,
          currency: currency_code.toLowerCase(),
          destination: driver.stripe_account_id,
          description: `Payout for driver ${driver.first_name} ${driver.last_name}`,
          metadata: {
            payout_item_id: payoutItem.id,
            driver_id,
            batch_id: batch.id,
          },
        }, { idempotencyKey });

        stripeTransferId = transfer.id;
        console.log(`[payout] Transfer created: ${transfer.id}`);

        try {
          const payout = await stripe.payouts.create({
            amount: payoutAmount,
            currency: currency_code.toLowerCase(),
          }, {
            stripeAccount: driver.stripe_account_id,
            idempotencyKey: `${idempotencyKey}_payout`,
          });
          stripePayoutId = payout.id;
          console.log(`[payout] Bank payout created: ${payout.id}`);
        } catch (payoutErr) {
          console.log('[payout] Bank payout skipped (may be automatic):', (payoutErr as Error).message);
        }
      } catch (stripeErr) {
        console.error('[payout] Stripe error:', stripeErr);
        stripeError = (stripeErr as Error).message;
      }
    } else {
      stripeError = 'STRIPE_SECRET_KEY not configured';
    }

    if (stripeError) {
      const failure = await recordPayoutFailureAndReturnToWallet({
        supabase,
        payoutItemId: payoutItem.id,
        batchId: batch.id,
        batchKind: kind,
        driverId: driver_id,
        netDriverPayoutPence: payoutAmount,
        snapshot: settlementSnapshot,
        providerStatus: 'failed',
        providerReference: null,
        rawFailureReason: stripeError,
      });

      return new Response(JSON.stringify({
        success: false,
        batchId: batch.id,
        payoutItemId: payoutItem.id,
        amount: payoutAmount,
        settlement_status: settlementSnapshot.cash_commission_recovered_pence > 0
          ? 'PARTIAL_SETTLEMENT'
          : 'FAILED',
        gross_payable_pence: settlementSnapshot.gross_payable_pence,
        cash_commission_recovered_pence: settlementSnapshot.cash_commission_recovered_pence,
        net_driver_payout_pence: settlementSnapshot.net_driver_payout_pence,
        driver_paid_out_pence: 0,
        failed_payout_amount_pence: payoutAmount,
        returned_to_wallet_pence: failure.returned_pence ?? payoutAmount,
        wallet_balance_before: available,
        wallet_balance_after: available + (failure.returned_pence ?? payoutAmount),
        currency_code,
        error: stripeError,
        wallet_returned: failure.success,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const finalize = await finalizePayoutAfterProviderSuccess({
      supabase,
      payoutItemId: payoutItem.id,
      batchId: batch.id,
      driverId: driver_id,
      payoutAmount,
      currencyCode: currency_code,
      batchKind: kind,
      stripeTransferId,
      stripePayoutId,
      walletBalanceBefore: available,
    });

    if (!finalize.success) {
      console.error('[payout] CRITICAL: Provider payout succeeded but ledger sync failed', finalize);
      return new Response(JSON.stringify({
        success: false,
        critical: true,
        alert: 'Provider payout completed but driver ledger was not fully debited. Retry ledger sync.',
        batchId: batch.id,
        payoutItemId: payoutItem.id,
        amount: payoutAmount,
        status: finalize.status,
        wallet_balance_before: available,
        wallet_balance_after: finalize.walletBalanceAfter,
        stripeTransferId,
        stripePayoutId,
        ledgerEntryId: finalize.ledgerEntryId,
        currency_code,
        error: finalize.error,
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    await recordPayoutSuccessDiagnostics({
      supabase,
      payoutItemId: payoutItem.id,
      snapshot: settlementSnapshot,
      netDriverPayoutPence: payoutAmount,
      providerStatus: 'paid',
      providerReference: stripeTransferId ?? stripePayoutId,
    });

    return new Response(JSON.stringify({
      success: true,
      batchId: batch.id,
      payoutItemId: payoutItem.id,
      amount: payoutAmount,
      payout_warning_reasons: ssot.payout_warning_reasons,
      payout_blocked_reasons: ssot.payout_blocked_reasons,
      settlement_status: 'COMPLETE',
      gross_payable_pence: settlementSnapshot.gross_payable_pence,
      cash_commission_recovered_pence: settlementSnapshot.cash_commission_recovered_pence,
      net_driver_payout_pence: settlementSnapshot.net_driver_payout_pence,
      driver_paid_out_pence: payoutAmount,
      wallet_balance_before: available,
      wallet_balance_after: finalize.walletBalanceAfter,
      stripeTransferId,
      stripePayoutId,
      ledgerEntryId: finalize.ledgerEntryId,
      walletRecalculated: finalize.walletRecalculated,
      currency_code,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[payout] Error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
