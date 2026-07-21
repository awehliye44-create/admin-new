export type PaymentProviderId =
  | "checkout_com"
  | "adyen"
  | "worldpay"
  | "braintree"
  | "sifalo_pay"
  | "waafi_pay"
  | "sahal_pay"
  | "intasend"
  | "paystack"
  | "flutterwave"
  | "pesapal"
  | "hubtel"
  | "dpo_pay"
  | "noda"
  | "revolut";

export type ProviderEnvironment = "test" | "live";

export type ProviderStatus =
  | "not_configured"
  | "connected"
  | "error"
  | "live"
  | "test";

export type WebhookHealthStatus = "healthy" | "failing" | "not_configured";

export interface ProviderSecrets {
  publishable_key?: string;
  secret_key?: string;
  webhook_secret?: string;
  merchant_id?: string;
  /** Revolut Business API OAuth access token (oa_prod_…) for driver payouts / counterparties. */
  business_access_token?: string;
}

export interface PaymentIntentResult {
  provider_payment_id: string;
  client_secret?: string;
  status: string;
}

export interface ProviderBalance {
  available_pence: number;
  pending_pence: number;
  currency: string;
}

export interface WebhookVerifyResult {
  valid: boolean;
  event_type?: string;
  event_id?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  provider?: PaymentProviderId;
  mode?: ProviderEnvironment;
  warnings?: string[];
  credentials_ready?: boolean;
  booking_adapter_live?: boolean;
  payout_adapter_live?: boolean;
  /** Revolut Merchant API by default; Business API only when explicitly probed. */
  api_surface?: "merchant" | "business";
  endpoint_tested?: string;
  http_status?: number;
  http_status_label?: string;
  /** Provider-native error code (Revolut code, Stripe code, etc.). */
  provider_error_code?: string | null;
  provider_error_message?: string | null;
  /** @deprecated use provider_error_code */
  revolut_error_code?: string | null;
  /** @deprecated use provider_error_message */
  revolut_message?: string | null;
}

export interface PaymentProviderAdapter {
  readonly provider: PaymentProviderId;
  createPaymentIntent(
    amountPence: number,
    currency: string,
    metadata?: Record<string, string>,
  ): Promise<PaymentIntentResult>;
  authorizePayment(providerPaymentId: string): Promise<{ status: string }>;
  capturePayment(providerPaymentId: string, amountPence?: number): Promise<{ status: string }>;
  refundPayment(
    providerPaymentId: string,
    amountPence?: number,
  ): Promise<{ status: string; refund_id?: string }>;
  createTransfer(
    amountPence: number,
    destinationAccountId: string,
    metadata?: Record<string, string>,
  ): Promise<{ transfer_id: string }>;
  createPayout(
    amountPence: number,
    destinationAccountId: string,
  ): Promise<{ payout_id: string }>;
  getBalance(currency?: string): Promise<ProviderBalance>;
  verifyWebhook(payload: string, signature: string): Promise<WebhookVerifyResult>;
  handleWebhookEvent(event: unknown): Promise<{ handled: boolean; message?: string }>;
  testConnection(): Promise<ConnectionTestResult>;
}

export const PROVIDER_ENV_SECRET_MAP: Record<
  PaymentProviderId,
  Partial<Record<keyof ProviderSecrets, string>>
> = {
  checkout_com: {
    publishable_key: "CHECKOUT_COM_PUBLIC_KEY",
    secret_key: "CHECKOUT_COM_SECRET_KEY",
    webhook_secret: "CHECKOUT_COM_WEBHOOK_SECRET",
  },
  adyen: {
    publishable_key: "ADYEN_CLIENT_KEY",
    secret_key: "ADYEN_API_KEY",
    webhook_secret: "ADYEN_WEBHOOK_HMAC_KEY",
  },
  worldpay: {
    publishable_key: "WORLDPAY_MERCHANT_ID",
    secret_key: "WORLDPAY_API_KEY",
    webhook_secret: "WORLDPAY_WEBHOOK_SECRET",
  },
  braintree: {
    publishable_key: "BRAINTREE_PUBLIC_KEY",
    secret_key: "BRAINTREE_PRIVATE_KEY",
    webhook_secret: "BRAINTREE_WEBHOOK_SECRET",
  },
  sifalo_pay: {
    publishable_key: "SIFALO_PAY_PUBLISHABLE_KEY",
    secret_key: "SIFALO_PAY_SECRET_KEY",
    webhook_secret: "SIFALO_PAY_WEBHOOK_SECRET",
    merchant_id: "SIFALO_PAY_MERCHANT_ID",
  },
  waafi_pay: {
    merchant_id: "WAAFI_PAY_MERCHANT_ID",
    secret_key: "WAAFI_PAY_API_KEY",
    webhook_secret: "WAAFI_PAY_WEBHOOK_SECRET",
  },
  sahal_pay: {
    publishable_key: "SAHAL_PAY_PUBLISHABLE_KEY",
    secret_key: "SAHAL_PAY_SECRET_KEY",
    webhook_secret: "SAHAL_PAY_WEBHOOK_SECRET",
    merchant_id: "SAHAL_PAY_MERCHANT_ID",
  },
  intasend: {
    publishable_key: "INTASEND_PUBLISHABLE_KEY",
    secret_key: "INTASEND_SECRET_KEY",
    webhook_secret: "INTASEND_WEBHOOK_SECRET",
    merchant_id: "INTASEND_MERCHANT_ID",
  },
  paystack: {
    publishable_key: "PAYSTACK_PUBLIC_KEY",
    secret_key: "PAYSTACK_SECRET_KEY",
    webhook_secret: "PAYSTACK_WEBHOOK_SECRET",
  },
  flutterwave: {
    publishable_key: "FLUTTERWAVE_PUBLIC_KEY",
    secret_key: "FLUTTERWAVE_SECRET_KEY",
    webhook_secret: "FLUTTERWAVE_WEBHOOK_SECRET",
  },
  pesapal: {
    publishable_key: "PESAPAL_CONSUMER_KEY",
    secret_key: "PESAPAL_CONSUMER_SECRET",
    webhook_secret: "PESAPAL_IPN_SECRET",
  },
  hubtel: {
    publishable_key: "HUBTEL_CLIENT_ID",
    secret_key: "HUBTEL_CLIENT_SECRET",
    webhook_secret: "HUBTEL_WEBHOOK_SECRET",
  },
  dpo_pay: {
    publishable_key: "DPO_PAY_COMPANY_TOKEN",
    secret_key: "DPO_PAY_SERVICE_TYPE",
    webhook_secret: "DPO_PAY_WEBHOOK_SECRET",
    merchant_id: "DPO_PAY_MERCHANT_ID",
  },
  noda: {
    publishable_key: "NODA_API_KEY",
    secret_key: "NODA_SECRET_KEY",
    webhook_secret: "NODA_WEBHOOK_SECRET",
    merchant_id: "NODA_MERCHANT_ID",
  },
  revolut: {
    publishable_key: "REVOLUT_PUBLIC_KEY",
    secret_key: "REVOLUT_MERCHANT_SECRET_KEY",
    webhook_secret: "REVOLUT_WEBHOOK_SECRET",
    merchant_id: "REVOLUT_MERCHANT_ID",
    business_access_token: "REVOLUT_BUSINESS_ACCESS_TOKEN",
  },
};

/** Additional Supabase Edge env fallbacks per provider secret field. */
export const PROVIDER_ENV_SECRET_FALLBACKS: Partial<
  Record<PaymentProviderId, Partial<Record<keyof ProviderSecrets, string[]>>>
> = {
  revolut: {
    webhook_secret: ["REVOLUT_WEBHOOK_SIGNING_SECRET"],
  },
};

/** Fields shown in admin secrets dialog per provider. */
export const PROVIDER_SECRET_FIELDS: Record<PaymentProviderId, (keyof ProviderSecrets)[]> = {
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
  noda: ["publishable_key", "secret_key", "webhook_secret", "merchant_id"],
  revolut: ["publishable_key", "secret_key", "webhook_secret", "merchant_id", "business_access_token"],
};

/** P0 supported providers — Integrations → Payment Providers UI. */
export const SUPPORTED_PAYMENT_PROVIDER_IDS: PaymentProviderId[] = [
  "sifalo_pay",
  "waafi_pay",
  "sahal_pay",
  "intasend",
  "paystack",
  "flutterwave",
  "pesapal",
  "hubtel",
  "dpo_pay",
  "noda",
  "revolut",
];

export type ProviderSecretFieldLabels = Partial<Record<keyof ProviderSecrets, string>>;

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
  noda: {
    publishable_key: "API key",
    secret_key: "Secret key",
    webhook_secret: "Webhook secret",
    merchant_id: "Merchant / account ID",
  },
  revolut: {
    publishable_key: "Production API Public key",
    secret_key: "Production API Secret key (sk_…)",
    webhook_secret: "Webhook signing secret",
    merchant_id: "Source Business account ID (payouts)",
    business_access_token: "Business API access token (oa_prod_…)",
  },
};
