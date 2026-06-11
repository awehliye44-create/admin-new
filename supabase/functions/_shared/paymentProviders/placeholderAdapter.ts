import type { PaymentProviderAdapter, PaymentProviderId } from "./types.ts";

function notImplemented(provider: string, method: string): never {
  throw new Error(`${provider} adapter: ${method} is not implemented yet`);
}

export function createPlaceholderAdapter(provider: PaymentProviderId): PaymentProviderAdapter {
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
    testConnection: async () => ({
      ok: false,
      message: `${label} integration is not configured yet. Add API keys when ready.`,
    }),
  };
}
