import type { PaymentProviderAdapter, PaymentProviderId, ProviderSecrets } from "./types.ts";

function notImplemented(provider: string, method: string): never {
  throw new Error(`${provider} adapter: ${method} is not implemented yet`);
}

export function createPlaceholderAdapter(
  provider: PaymentProviderId,
  getSecrets?: () => Promise<ProviderSecrets>,
): PaymentProviderAdapter {
  const label = provider.replace(/_/g, " ");
  return {
    provider,
    createPaymentIntent: () => Promise.reject(notImplemented(label, "createPaymentIntent")),
    authorizePayment: () => Promise.reject(notImplemented(label, "authorizePayment")),
    capturePayment: () => Promise.reject(notImplemented(label, "capturePayment")),
    refundPayment: () => Promise.reject(notImplemented(label, "refundPayment")),
    createTransfer: () => Promise.reject(notImplemented(label, "createTransfer")),
    createPayout: () => Promise.reject(notImplemented(label, "createPayout")),
    getBalance: () => Promise.reject(notImplemented(label, "getBalance")),
    verifyWebhook: () => Promise.reject(notImplemented(label, "verifyWebhook")),
    handleWebhookEvent: () => Promise.reject(notImplemented(label, "handleWebhookEvent")),
    testConnection: async () => {
      const secrets = getSecrets ? await getSecrets() : {};
      const hasCredentials = Boolean(secrets.secret_key?.trim());
      return {
        ok: hasCredentials,
        message: hasCredentials
          ? `${label} credentials stored. Booking adapter PROVIDER_NOT_IMPLEMENTED — not live until adapter, webhook processing, sandbox test, and production approval.`
          : `Add API keys to prepare ${label} for future use.`,
        credentials_ready: hasCredentials,
        booking_adapter_live: false,
      };
    },
  };
}
