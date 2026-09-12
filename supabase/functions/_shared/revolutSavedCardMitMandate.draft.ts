/**
 * DRAFT — not wired into live booking charges.
 *
 * Customer-saved methods (`savePaymentMethodFor: 'customer'`, `initiator: 'customer'`)
 * remain customer-initiated. Revolut/SCA may return an ACS URL on every booking.
 * Do not skip that challenge.
 *
 * Repeat booking without 3DS requires a merchant-saved mandate:
 *   first checkout: savePaymentMethodFor = 'merchant' (3DS once)
 *   later charge: initiator = 'merchant' AND method.saved_for = 'merchant'
 * Never set initiator=merchant for a customer-saved method.
 */
export type SavedCardChargeInitiator = 'customer' | 'merchant';

export function resolveSavedCardChargeInitiator(input: {
  methodSavedFor: string | null | undefined;
  merchantMandateApproved: boolean;
}): { initiator: SavedCardChargeInitiator; maySkip3ds: boolean } {
  const savedFor = String(input.methodSavedFor ?? '').trim().toLowerCase();
  if (input.merchantMandateApproved && savedFor === 'merchant') {
    return { initiator: 'merchant', maySkip3ds: true };
  }
  return { initiator: 'customer', maySkip3ds: false };
}

export function mustPresentAcsWhenRevolutRequires(acsUrl: string | null | undefined): boolean {
  return String(acsUrl ?? '').trim().toLowerCase().startsWith('https://');
}
