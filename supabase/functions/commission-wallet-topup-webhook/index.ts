/**
 * Commission Wallet top-up webhook — Phase 4.
 * HMAC-verified Waafi-shaped sandbox events → TOP_UP_CREDIT (or FAILED/EXPIRED).
 * Never writes driver_wallet_ledger.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  confirmCommissionWalletTopupCredit,
  markCommissionWalletTopupTerminal,
} from "../_shared/commissionWalletTopupConfirm.ts";
import {
  WAAFI_SANDBOX_PROVIDER,
  WAAFI_SANDBOX_SIGNATURE_HEADER,
  parseWaafiSandboxWebhookPayload,
  verifyWaafiSandboxWebhookSignature,
} from "../_shared/commissionWalletProviders/waafiSandboxAdapter.ts";
import { COMMISSION_TOPUP_STATUS } from "../../../shared/commissionWalletSSOT.ts";
import { getProviderSecrets } from "../_shared/paymentProviders/secretManager.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-waafi-signature",
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
    const rawBody = await req.text();
    const signature = req.headers.get(WAAFI_SANDBOX_SIGNATURE_HEADER);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Prefer vault webhook_secret; fall back to env for sandbox pilots. Never hardcode.
    let webhookSecret = Deno.env.get("WAAFI_PAY_WEBHOOK_SECRET")?.trim() ?? "";
    try {
      const secrets = await getProviderSecrets(supabase, "waafi_pay", "test");
      if (secrets.webhook_secret?.trim()) webhookSecret = secrets.webhook_secret.trim();
    } catch (e) {
      console.warn("[commission-wallet-topup-webhook] vault secrets unavailable", e);
    }
    if (!webhookSecret) {
      webhookSecret = Deno.env.get("COMMISSION_WALLET_TOPUP_SANDBOX_WEBHOOK_SECRET")?.trim() ?? "";
    }
    if (!webhookSecret) {
      return json({
        success: false,
        error: "Webhook secret not configured",
        code: "WEBHOOK_SECRET_MISSING",
      }, 503);
    }

    const okSig = await verifyWaafiSandboxWebhookSignature(rawBody, signature, webhookSecret);
    if (!okSig) {
      return json({ success: false, error: "Invalid signature", code: "INVALID_SIGNATURE" }, 401);
    }

    let parsedJson: unknown = null;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      return json({ success: false, error: "Invalid JSON", code: "INVALID_BODY" }, 400);
    }

    const payload = parseWaafiSandboxWebhookPayload(parsedJson);
    if (!payload) {
      return json({ success: false, error: "Unsupported webhook payload", code: "INVALID_PAYLOAD" }, 400);
    }

    const provider = payload.provider || WAAFI_SANDBOX_PROVIDER;

    if (payload.event === "payment.failed") {
      const marked = await markCommissionWalletTopupTerminal(supabase, {
        provider,
        providerTransactionId: payload.provider_transaction_id,
        status: COMMISSION_TOPUP_STATUS.FAILED,
      });
      if (!marked.ok) {
        return json({ success: false, error: marked.error, code: marked.code }, marked.status ?? 400);
      }
      return json({ success: true, status: COMMISSION_TOPUP_STATUS.FAILED });
    }

    if (payload.event === "payment.expired") {
      const marked = await markCommissionWalletTopupTerminal(supabase, {
        provider,
        providerTransactionId: payload.provider_transaction_id,
        status: COMMISSION_TOPUP_STATUS.EXPIRED,
      });
      if (!marked.ok) {
        return json({ success: false, error: marked.error, code: marked.code }, marked.status ?? 400);
      }
      return json({ success: true, status: COMMISSION_TOPUP_STATUS.EXPIRED });
    }

    const confirm = await confirmCommissionWalletTopupCredit(supabase, {
      topupId: payload.topup_id ?? null,
      provider,
      providerTransactionId: payload.provider_transaction_id,
      confirmedAmountMinor: payload.amount_minor,
      confirmedCurrency: payload.currency,
    });

    if (!confirm.ok) {
      return json({
        success: false,
        error: confirm.error,
        code: confirm.code,
      }, confirm.status ?? 400);
    }

    return json({
      success: true,
      phase: 5,
      already_succeeded: confirm.already_succeeded,
      topup_id: confirm.topup_id,
      ledger_entry_id: confirm.ledger_entry_id,
      bonus: confirm.bonus ?? null,
      status: COMMISSION_TOPUP_STATUS.SUCCEEDED,
    });
  } catch (err) {
    console.error("[commission-wallet-topup-webhook]", err);
    return json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }, 500);
  }
});
