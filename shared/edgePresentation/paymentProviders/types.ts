/** Admin presentation-only helpers; not part of Edge uploads. */
import { PaymentProviderId, ProviderSecretFieldLabels } from "../../../supabase/functions/_shared/paymentProviders/types.ts";


export const PROVIDER_SECRET_FIELD_LABELS: Record<PaymentProviderId, ProviderSecretFieldLabels> = {
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
  noda: {
    publishable_key: "API key",
    secret_key: "Secret key",
    webhook_secret: "Webhook secret",
    merchant_id: "Merchant / account ID",
  },
  barclaycard_smartpay: {},
  revolut: {
    publishable_key: "Production API Public key",
    secret_key: "Production API Secret key (sk_…)",
    webhook_secret: "Webhook signing secret",
    merchant_id: "Source Business account ID (payouts)",
    business_access_token: "Business API access token (oa_prod_…)",
  },
};
