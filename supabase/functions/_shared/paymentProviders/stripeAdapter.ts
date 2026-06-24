import Stripe from "https://esm.sh/stripe@14.21.0";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getProviderSecrets,
  detectModeMismatch,
} from "./secretManager.ts";
import type {
  ConnectionTestResult,
  PaymentProviderAdapter,
  ProviderBalance,
  ProviderEnvironment,
  WebhookVerifyResult,
} from "./types.ts";
import { STRIPE_STATEMENT_DESCRIPTOR } from "../stripeStatementDescriptor.ts";

export function createStripeAdapter(
  supabase: SupabaseClient,
  environment: ProviderEnvironment,
): PaymentProviderAdapter {
  let stripeClient: Stripe | null = null;

  async function getStripe(): Promise<Stripe> {
    if (stripeClient) return stripeClient;
    const secrets = await getProviderSecrets(supabase, "stripe", environment);
    if (!secrets.secret_key) {
      throw new Error("Stripe secret key is not configured");
    }
    stripeClient = new Stripe(secrets.secret_key, { apiVersion: "2023-10-16" });
    return stripeClient;
  }

  return {
    provider: "stripe",

    async createPaymentIntent(amountPence, currency, metadata = {}) {
      const stripe = await getStripe();
      console.log(`[stripe-adapter] Statement descriptor SSOT: ${STRIPE_STATEMENT_DESCRIPTOR}`);
      const pi = await stripe.paymentIntents.create({
        amount: amountPence,
        currency: currency.toLowerCase(),
        metadata,
        capture_method: "manual",
      });
      return {
        provider_payment_id: pi.id,
        client_secret: pi.client_secret ?? undefined,
        status: pi.status,
      };
    },

    async authorizePayment(providerPaymentId) {
      const stripe = await getStripe();
      const pi = await stripe.paymentIntents.retrieve(providerPaymentId);
      return { status: pi.status };
    },

    async capturePayment(providerPaymentId, amountPence) {
      const stripe = await getStripe();
      const pi = await stripe.paymentIntents.capture(
        providerPaymentId,
        amountPence ? { amount_to_capture: amountPence } : undefined,
      );
      return { status: pi.status };
    },

    async refundPayment(providerPaymentId, amountPence) {
      const stripe = await getStripe();
      const refund = await stripe.refunds.create({
        payment_intent: providerPaymentId,
        amount: amountPence,
      });
      return { status: refund.status ?? "succeeded", refund_id: refund.id };
    },

    async createTransfer(amountPence, destinationAccountId, metadata = {}) {
      const stripe = await getStripe();
      const transfer = await stripe.transfers.create({
        amount: amountPence,
        currency: "gbp",
        destination: destinationAccountId,
        metadata,
      });
      return { transfer_id: transfer.id };
    },

    async createPayout(amountPence, destinationAccountId) {
      const stripe = await getStripe();
      const payout = await stripe.payouts.create(
        { amount: amountPence, currency: "gbp" },
        { stripeAccount: destinationAccountId },
      );
      return { payout_id: payout.id };
    },

    async getBalance(currency = "gbp") {
      const stripe = await getStripe();
      const balance = await stripe.balance.retrieve();
      const avail = balance.available.find((b) => b.currency === currency.toLowerCase());
      const pend = balance.pending.find((b) => b.currency === currency.toLowerCase());
      return {
        available_pence: avail?.amount ?? 0,
        pending_pence: pend?.amount ?? 0,
        currency: currency.toLowerCase(),
      } satisfies ProviderBalance;
    },

    async verifyWebhook(payload, signature) {
      const secrets = await getProviderSecrets(supabase, "stripe", environment);
      if (!secrets.webhook_secret) {
        return { valid: false };
      }
      try {
        const stripe = await getStripe();
        const event = stripe.webhooks.constructEvent(
          payload,
          signature,
          secrets.webhook_secret,
        );
        return {
          valid: true,
          event_type: event.type,
          event_id: event.id,
        } satisfies WebhookVerifyResult;
      } catch {
        return { valid: false };
      }
    },

    async handleWebhookEvent(_event) {
      return { handled: true, message: "Stripe webhook events are processed by stripe-webhook edge function" };
    },

    async testConnection(): Promise<ConnectionTestResult> {
      const secrets = await getProviderSecrets(supabase, "stripe", environment);
      const warnings: string[] = [];
      if (!secrets.secret_key) {
        return { ok: false, message: "Stripe secret key is missing" };
      }
      const mismatch = detectModeMismatch(environment, secrets.secret_key);
      if (mismatch) warnings.push(mismatch);

      try {
        const stripe = new Stripe(secrets.secret_key, { apiVersion: "2023-10-16" });
        const balance = await stripe.balance.retrieve();
        const mode: ProviderEnvironment = secrets.secret_key.includes("_test_")
          ? "test"
          : secrets.secret_key.includes("_live_")
          ? "live"
          : environment;
        return {
          ok: true,
          message: `Connected to Stripe (${mode}). ${balance.available.length} currency balance(s) available.`,
          mode,
          warnings: warnings.length ? warnings : undefined,
        };
      } catch (e) {
        return { ok: false, message: (e as Error).message, warnings };
      }
    },
  };
}
