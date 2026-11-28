/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Driver-safe / customer-safe Revolut payment error messages.
 *
 * Bank-decline wording only when the input carries a decline reason that the
 * bank, card issuer or card network is responsible for (unified-bank-decline-copy
 * lock). Revolut uses the `declined` and `failed` payment states for technical,
 * risk and data failures too, so a state, generic "failed"/"declined" text, a
 * timeout or an unknown reason always gets neutral copy. Raw provider/internal
 * text is never shown.
 */
import { REVOLUT_PAYMENT_SETUP_FAILED_MESSAGE } from "../../../functions/_shared/revolutPreauthCustomerAttach.ts";


export const BANK_DECLINE_TITLE = "Payment declined by your bank";

export * from "../../../functions/_shared/revolutCustomerError.ts";
