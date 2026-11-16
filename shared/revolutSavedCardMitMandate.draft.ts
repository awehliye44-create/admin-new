/**
 * DRAFT — genuine off-session ONECAB merchant-initiated charges ONLY.
 * NOT wired into Book / create-preauth / attemptRevolutSavedCardCharge.
 *
 * HARD RULES (Phase 2 correction):
 * - Customer taps Book → ALWAYS CIT (`initiator: 'customer'`), even when
 *   Revolut reports `saved_for === 'merchant'`.
 * - `saved_for=merchant` = reusable credential storage type only.
 * - Never set Book initiator from saved_for. Never suppress issuer 3DS on Book.
 * - This helper is reserved for future genuine off-session ONECAB actions
 *   (excluded from this booking PR). Do not import from revolutPreauth.
 *
 * Revolut pay-with-saved fields (Merchant API):
 *   POST /orders/{id}/payments
 *   { saved_payment_method: { type, id, initiator, environment } }
 * Challenge response: payment.state=authentication_challenge,
 *   authentication_challenge.acs_url → CUSTOMER_ACTION_REQUIRED.
 */
export type SavedCardChargeInitiator = 'customer' | 'merchant';

/**
 * Draft MIT resolver for genuine off-session actions — NOT for Book.
 * Book call sites must hardcode initiator "customer".
 */
export function resolveSavedCardChargeInitiator(input: {
  methodSavedFor: string | null | undefined;
  merchantMandateApproved: boolean;
  /** When true (Book / customer-tapped), always CIT regardless of saved_for. */
  customerPresent?: boolean;
}): { initiator: SavedCardChargeInitiator; maySkip3ds: boolean } {
  if (input.customerPresent === true) {
    return { initiator: 'customer', maySkip3ds: false };
  }
  const savedFor = String(input.methodSavedFor ?? '').trim().toLowerCase();
  if (input.merchantMandateApproved && savedFor === 'merchant') {
    return { initiator: 'merchant', maySkip3ds: true };
  }
  return { initiator: 'customer', maySkip3ds: false };
}

export function mustPresentAcsWhenRevolutRequires(acsUrl: string | null | undefined): boolean {
  return String(acsUrl ?? '').trim().toLowerCase().startsWith('https://');
}
