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
  formatRevolutApiFailure,
  resolveRevolutBusinessAccessToken,
  REVOLUT_MERCHANT_COLLECTION_PROBE,
  revolutMerchantRequest,
  testRevolutBusinessConnection,
  type RevolutApiError,
} from "../revolutApi.ts";
import {
  probeRevolutMerchantCredentials,
  revolutSecretFingerprint,
  syncRevolutVaultFromProbe,
} from "./revolutSecretResolution.ts";

function revolutProbeFailure(
  environment: ProviderEnvironment,
  err: RevolutApiError,
  apiSurface: "merchant" | "business",
  endpoint: string,
  source?: string,
): ConnectionTestResult {
  if (err.status === 0) {
    return {
      ok: false,
      provider: "revolut",
      mode: environment,
      api_surface: apiSurface,
      endpoint_tested: endpoint,
      message: err.message,
      provider_error_message: err.message,
      credentials_ready: false,
      booking_adapter_live: false,
      payout_adapter_live: false,
    };
  }

  const failure = formatRevolutApiFailure(err, apiSurface);
  return {
    ok: false,
    provider: "revolut",
    mode: environment,
    api_surface: failure.api_surface,
    endpoint_tested: endpoint,
    message: failure.message,
    provider_error_code: failure.revolut_error_code,
    provider_error_message: failure.revolut_message,
    revolut_error_code: failure.revolut_error_code,
    revolut_message: failure.revolut_message,
    http_status: failure.http_status,
    http_status_label: failure.http_status_label,
    credentials_ready: true,
    booking_adapter_live: false,
    payout_adapter_live: false,
    ...(source ? { warnings: [`Secret source: ${source}`] } : {}),
  };
}

export function createRevolutAdapter(
  supabase: SupabaseClient,
  environment: ProviderEnvironment,
  options?: { updatedBy?: string },
): PaymentProviderAdapter {
  async function getSecrets() {
    return getProviderSecrets(supabase, "revolut", environment);
  }

  function merchantSecret(secrets: Awaited<ReturnType<typeof getSecrets>>): string {
    const token = secrets.secret_key?.trim();
    if (!token) throw new Error("Revolut Merchant API secret key is not configured");
    return token;
  }

  async function businessAccessToken(): Promise<string> {
    const secrets = await getSecrets();
    const token = secrets.business_access_token?.trim()
      ?? await resolveRevolutBusinessAccessToken(supabase, environment);
    if (!token) {
      throw new Error(
        "Revolut Business API access token is not configured (oa_prod_…). Add it in admin → Revolut → Edit secrets.",
      );
    }
    return token;
  }

  return {
    provider: "revolut",

    async createPaymentIntent(amountPence, currency, metadata = {}) {
      const secrets = await getSecrets();
      const sk = merchantSecret(secrets);
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
      const sk = merchantSecret(secrets);
      const order = await revolutMerchantRequest<{ state?: string }>(
        environment,
        sk,
        `/orders/${providerPaymentId}`,
      );
      return { status: order.state ?? "pending" };
    },

    async capturePayment(providerPaymentId, amountPence) {
      const secrets = await getSecrets();
      const sk = merchantSecret(secrets);
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
      const sk = merchantSecret(secrets);
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
        accessToken: await businessAccessToken(),
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
        accessToken: await businessAccessToken(),
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
      const token = await businessAccessToken();
      const { listRevolutAccounts } = await import("../revolutApi.ts");
      const accounts = await listRevolutAccounts(environment, token);
      const target = currency.toLowerCase();
      let availableMajor = 0;
      for (const account of accounts) {
        const acctCurrency = String(account.currency ?? target).toLowerCase();
        if (acctCurrency !== target) continue;
        if (String(account.state ?? "active").toLowerCase() === "inactive") continue;
        availableMajor += Math.max(0, Number(account.balance ?? 0));
      }
      return {
        available_pence: Math.round(availableMajor * 100),
        pending_pence: 0,
        currency: target,
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
      const api_surface = "merchant" as const;
      const probe = await probeRevolutMerchantCredentials(supabase, environment);

      if (!probe.ok) {
        const primary = probe.attempts[0];
        return {
          ok: false,
          provider: "revolut",
          mode: environment,
          api_surface,
          endpoint_tested: REVOLUT_MERCHANT_COLLECTION_PROBE,
          message: probe.message,
          provider_error_message: probe.message,
          http_status: primary?.http_status,
          credentials_ready: probe.attempts.length > 0,
          booking_adapter_live: false,
          payout_adapter_live: false,
          warnings: probe.attempts.length > 1
            ? probe.attempts.map((a) => `${a.source}: ${a.message}`)
            : undefined,
        };
      }

      const warnings = [...probe.warnings];
      const mismatch = detectModeMismatch(environment, probe.candidate.secret_key);
      if (mismatch) warnings.push(mismatch);

      if (options?.updatedBy) {
        try {
          await syncRevolutVaultFromProbe(
            supabase,
            environment,
            probe.candidate,
            options.updatedBy,
          );
          if (!probe.candidate.source.startsWith("vault:")) {
            warnings.push("Working secret copied to vault for Live mode.");
          }
        } catch (syncErr) {
          warnings.push(`Could not sync secret to vault: ${(syncErr as Error).message}`);
        }
      }

      const secrets = await getSecrets();
      const payoutAccountConfigured = Boolean(secrets.merchant_id?.trim());
      const businessToken = secrets.business_access_token?.trim()
        ?? await resolveRevolutBusinessAccessToken(supabase, environment);
      let businessApiOk = false;
      if (businessToken) {
        try {
          await testRevolutBusinessConnection(environment, businessToken);
          businessApiOk = true;
        } catch (businessErr) {
          warnings.push(`Business API: ${(businessErr as RevolutApiError).message}`);
        }
      } else {
        warnings.push(
          "Business API access token (oa_prod_…) missing — required for driver payout onboarding and transfers",
        );
      }
      if (!payoutAccountConfigured) {
        warnings.push(
          "Source Business account ID (merchant_id) missing — required for driver payout execution",
        );
      }

      return {
        ok: true,
        provider: "revolut",
        mode: environment,
        api_surface,
        endpoint_tested: probe.endpoint_tested,
        message: businessApiOk && payoutAccountConfigured
          ? `Revolut Merchant + Business API ready (${environment} mode).`
          : `Revolut Merchant API authenticated (${environment} mode). Complete Business API token + source account ID for driver payouts.`,
        warnings: [
          ...warnings,
          `Merchant secret fingerprint: ${revolutSecretFingerprint(probe.candidate.secret_key)}`,
        ],
        credentials_ready: true,
        booking_adapter_live: true,
        payout_adapter_live: businessApiOk && payoutAccountConfigured,
      };
    },
  };
}
