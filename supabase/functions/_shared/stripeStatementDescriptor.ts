/**
 * Bank / card statement merchant name SSOT.
 *
 * Card charges: Stripe shows the account static descriptor when no suffix is set.
 * Do NOT pass `statement_descriptor_suffix` on PaymentIntents.
 *
 * Dashboard: Settings → Business → Public details → Statement descriptor =
 * exactly `ONECAB LIMITED`.
 */
export const STRIPE_STATEMENT_DESCRIPTOR = "ONECAB LIMITED";
