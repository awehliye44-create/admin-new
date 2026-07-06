import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getProviderSecrets, detectModeMismatch } from "./secretManager.ts";
import type {
  ConnectionTestResult,
  PaymentProviderAdapter,
  ProviderBalance,
  ProviderEnvironment,
  WebhookVerifyResult,
} from "./types.ts";
import {
  executeRevolutPay,
  listRevolutAccounts,
  revolutMerchantRequest,
} from "../revolutApi.ts";

export function createRevolutAdapter(
  supabase: SupabaseClient,
  environment: ProviderEnvironment,
): PaymentProviderAdapter {
  async function getSecrets() {
    return getProviderSecrets(supabase, "revolut", environment);
  }

  function businessToken(secrets: Awaited<ReturnType<typeof getSecrets>>): string {
    const token = secrets.secret_key?.trim();
    if (!token) throw new Error("Revolut API secret key is not configured");
    return token;
  }

  return {
    provider: "revolut",

    async createPaymentIntent(amountPence, currency, metadata = {}) {
      const secrets = await getSecrets();
      const sk = businessToken(secrets);
      const order = await revolutMerchantRequest<{
        id: string;
        token?: string;
        state?: string;
        checkout_url?: string;
      }>(environment, sk, "/orders", {
        method: "POST",
        body: JSON.stringify({
          amount: amountPence,
          currency: currency.toUpperCase(),
          capture_mode: "manual",
          merchant_order_ext_ref: metadata.trip_id ?? metadata.tripId ?? undefined,
          description: metadata.description ?? "ONECAB trip payment",
        }),
      });
      return {
        provider_payment_id: order.id,
        client_secret: order.token ?? order.checkout_url,
        status: order.state ?? "pending",
      };
    },

    async authorizePayment(providerPaymentId) {
      const secrets = await getSecrets();
      const sk = businessToken(secrets);
      const order = await revolutMerchantRequest<{ state?: string }>(
        environment,
        sk,
        `/orders/${providerPaymentId}`,
      );
      return { status: order.state ?? "pending" };
    },

    async capturePayment(providerPaymentId, amountPence) {
      const secrets = await getSecrets();
      const sk = businessToken(secrets);
      const order = await revolutMerchantRequest<{ state?: string }>(
        environment,
        sk,
        `/orders/${providerPaymentId}/capture`,
        {
          method: "POST",
          body: JSON.stringify(amountPence ? { amount: amountPence } : {}),
        },
      );
      return { status: order.state ?? "completed" };
    },

    async refundPayment(providerPaymentId, amountPence) {
      const secrets = await getSecrets();
      const sk = businessToken(secrets);
      const refund = await revolutMerchantRequest<{ id?: string; state?: string }>(
        environment,
        sk,
        `/orders/${providerPaymentId}/refund`,
        {
          method: "POST",
          body: JSON.stringify(amountPence ? { amount: amountPence } : {}),
        },
      );
      return { status: refund.state ?? "completed", refund_id: refund.id };
    },

    async createTransfer(amountPence, destinationAccountId, metadata = {}) {
      const secrets = await getSecrets();
      const accountId = secrets.merchant_id?.trim();
      if (!accountId) throw new Error("Revolut merchant / account ID is not configured");
      const pay = await executeRevolutPay({
        environment,
        accessToken: businessToken(secrets),
        sourceAccountId: accountId,
        counterpartyId: destinationAccountId,
        amountPence,
        currencyCode: (metadata.currency as string) ?? "GBP",
        reference: (metadata.reference as string) ?? "ONECAB transfer",
        requestId: (metadata.request_id as string) ?? crypto.randomUUID(),
      });
      return { transfer_id: pay.id };
    },

    async createPayout(amountPence, destinationAccountId) {
      const secrets = await getSecrets();
      const accountId = secrets.merchant_id?.trim();
      if (!accountId) throw new Error("Revolut merchant / account ID is not configured");
      const pay = await executeRevolutPay({
        environment,
        accessToken: businessToken(secrets),
        sourceAccountId: accountId,
        counterpartyId: destinationAccountId,
        amountPence,
        currencyCode: "GBP",
        reference: "ONECAB driver payout",
        requestId: crypto.randomUUID(),
      });
      return { payout_id: pay.id };
    },

    async getBalance(currency = "gbp") {
      const secrets = await getSecrets();
      const accounts = await listRevolutAccounts(environment, businessToken(secrets));
      const match = accounts.find((a) => (a.currency ?? "").toLowerCase() === currency.toLowerCase())
        ?? accounts[0];
      const balanceMajor = Number(match?.balance ?? 0);
      return {
        available_pence: Math.round(balanceMajor * 100),
        pending_pence: 0,
        currency: currency.toLowerCase(),
      } satisfies ProviderBalance;
    },

    async verifyWebhook(payload, signature) {
      const secrets = await getSecrets();
      if (!secrets.webhook_secret?.trim()) return { valid: false };
      const expected = secrets.webhook_secret.trim();
      return {
        valid: signature === expected || signature.includes(expected),
        event_type: undefined,
        event_id: undefined,
      } satisfies WebhookVerifyResult;
    },

    async handleWebhookEvent(_event) {
      return { handled: false, message: "Revolut webhook processing not wired in this function yet" };
    },

    async testConnection(): Promise<ConnectionTestResult> {
      const secrets = await getSecrets();
      const warnings: string[] = [];
      if (!secrets.secret_key?.trim()) {
        return { ok: false, message: "Revolut API secret key is missing", credentials_ready: false };
      }
      const mismatch = detectModeMismatch(environment, secrets.secret_key);
      if (mismatch) warnings.push(mismatch);
      if (!secrets.merchant_id?.trim()) {
        warnings.push("Merchant / source account ID missing — driver payouts require merchant_id");
      }
      try {
        const accounts = await listRevolutAccounts(environment, secrets.secret_key.trim());
        const liveOk = accounts.length > 0;
        return {
          ok: liveOk,
          message: liveOk
            ? `Revolut Business API connected (${accounts.length} account(s)). Live payout adapter enabled.`
            : "Revolut API responded but returned no accounts",
          mode: environment,
          warnings: warnings.length ? warnings : undefined,
          credentials_ready: true,
          booking_adapter_live: true,
        };
      } catch (err) {
        const msg = (err as { message?: string })?.message ?? String(err);
        return {
          ok: false,
          message: `Revolut connection failed: ${msg}`,
          mode: environment,
          warnings,
          credentials_ready: Boolean(secrets.secret_key?.trim()),
          booking_adapter_live: false,
        };
      }
    },
  };
}
