import type { PaymentProviderId } from "@/hooks/usePaymentProviders";

/** Keep in sync with supabase/functions/_shared/paymentProviders/types.ts */
export const SUPPORTED_PAYMENT_PROVIDER_IDS: PaymentProviderId[] = [
  "stripe",
  "sifalo_pay",
  "waafi_pay",
  "sahal_pay",
  "intasend",
  "paystack",
  "flutterwave",
  "pesapal",
  "hubtel",
  "dpo_pay",
];

export type ProviderSecretName = "publishable_key" | "secret_key" | "webhook_secret" | "merchant_id";

export const PROVIDER_SECRET_FIELDS: Record<PaymentProviderId, ProviderSecretName[]> = {
  stripe: ["publishable_key", "secret_key", "webhook_secret"],
  checkout_com: ["publishable_key", "secret_key", "webhook_secret"],
  adyen: ["publishable_key", "secret_key", "webhook_secret"],
  worldpay: ["publishable_key", "secret_key", "webhook_secret"],
  braintree: ["publishable_key", "secret_key", "webhook_secret"],
  sifalo_pay: ["publishable_key", "secret_key", "webhook_secret", "merchant_id"],
  waafi_pay: ["merchant_id", "secret_key", "webhook_secret"],
  sahal_pay: ["publishable_key", "secret_key", "webhook_secret", "merchant_id"],
  intasend: ["publishable_key", "secret_key", "webhook_secret", "merchant_id"],
  paystack: ["publishable_key", "secret_key", "webhook_secret"],
  flutterwave: ["publishable_key", "secret_key", "webhook_secret"],
  pesapal: ["publishable_key", "secret_key", "webhook_secret"],
  hubtel: ["publishable_key", "secret_key", "webhook_secret"],
  dpo_pay: ["publishable_key", "secret_key", "webhook_secret", "merchant_id"],
};

export type ProviderSecretFieldLabels = Partial<Record<ProviderSecretName, string>>;

export const PROVIDER_SECRET_FIELD_LABELS: Record<PaymentProviderId, ProviderSecretFieldLabels> = {
  stripe: {
    publishable_key: "Publishable key",
    secret_key: "Secret key",
    webhook_secret: "Webhook secret",
  },
  checkout_com: {
    publishable_key: "Public key",
    secret_key: "Secret key",
    webhook_secret: "Webhook secret",
  },
  adyen: {
    publishable_key: "Client key",
    secret_key: "API key",
    webhook_secret: "Webhook HMAC key",
  },
  worldpay: {
    publishable_key: "Merchant ID",
    secret_key: "API key",
    webhook_secret: "Webhook secret",
  },
  braintree: {
    publishable_key: "Public key",
    secret_key: "Private key",
    webhook_secret: "Webhook secret",
  },
  sifalo_pay: {
    publishable_key: "Publishable key",
    secret_key: "Secret key",
    webhook_secret: "Webhook secret",
    merchant_id: "Merchant ID",
  },
  waafi_pay: {
    merchant_id: "Merchant ID",
    secret_key: "API key",
    webhook_secret: "Webhook secret",
  },
  sahal_pay: {
    publishable_key: "Publishable key",
    secret_key: "Secret key",
    webhook_secret: "Webhook secret",
    merchant_id: "Merchant ID",
  },
  intasend: {
    publishable_key: "Publishable key",
    secret_key: "Secret key",
    webhook_secret: "Webhook secret",
    merchant_id: "Merchant ID",
  },
  paystack: {
    publishable_key: "Public key",
    secret_key: "Secret key",
    webhook_secret: "Webhook secret",
  },
  flutterwave: {
    publishable_key: "Public key",
    secret_key: "Secret key",
    webhook_secret: "Webhook secret",
  },
  pesapal: {
    publishable_key: "Consumer key",
    secret_key: "Consumer secret",
    webhook_secret: "IPN secret",
  },
  hubtel: {
    publishable_key: "Client ID",
    secret_key: "Client secret",
    webhook_secret: "Webhook secret",
  },
  dpo_pay: {
    publishable_key: "Company token",
    secret_key: "Service type",
    webhook_secret: "Webhook secret",
    merchant_id: "Merchant ID",
  },
};
