/**
 * Edge re-export of Waafi sandbox adapter SSOT (Commission Wallet top-up only).
 * Never used by booking Stripe/Revolut payment adapters.
 */
export {
  WAAFI_SANDBOX_PROVIDER,
  WAAFI_SANDBOX_SIGNATURE_HEADER,
  createWaafiSandboxPayment,
  parseWaafiSandboxWebhookPayload,
  signWaafiSandboxWebhook,
  verifyWaafiSandboxWebhookSignature,
  type WaafiSandboxCreatePaymentInput,
  type WaafiSandboxCreatePaymentResult,
  type WaafiSandboxWebhookPayload,
} from "../../../../shared/waafiSandboxAdapterSSOT.ts";
