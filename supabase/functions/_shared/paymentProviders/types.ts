export type PaymentProviderId =
  | "stripe"
  | "checkout_com"
  | "adyen"
  | "worldpay"
  | "braintree";

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
  mode?: ProviderEnvironment;
  warnings?: string[];
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

export const STRIPE_MONITORED_EVENTS = [
  "payment_intent.succeeded",
  "payment_intent.amount_capturable_updated",
  "charge.succeeded",
  "charge.refunded",
  "balance.available",
  "payout.paid",
  "payout.failed",
  "account.updated",
] as const;

export const PROVIDER_ENV_SECRET_MAP: Record<
  PaymentProviderId,
  Record<keyof ProviderSecrets, string>
> = {
  stripe: {
    publishable_key: "STRIPE_PUBLISHABLE_KEY",
    secret_key: "STRIPE_SECRET_KEY",
    webhook_secret: "STRIPE_WEBHOOK_SECRET",
  },
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
};
