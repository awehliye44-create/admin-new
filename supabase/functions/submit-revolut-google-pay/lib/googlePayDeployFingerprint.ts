/**
 * Bug #37 — deploy fingerprint embedded in the Edge bundle.
 * verify-critical-payment-edge-deployed.sh requires this exact string so
 * marker-only checks cannot pass against an older billing-contract deploy.
 * Bump the suffix when the Google Pay submit contract changes materially.
 */
export const GOOGLE_PAY_EDGE_DEPLOY_FINGERPRINT =
  "BUG37_GPAY_EDGE_FINGERPRINT_v5_token_rejected_not_billing";
