/**
 * Booking preauth amount guard — never create / accept a £1 save-card
 * verification hold when the booking fare is higher.
 *
 * Aligns with customer-app validateBookingPreauthAmount +
 * revolutSavedCardVault.REVOLUT_SAVE_CARD_VERIFICATION_MINOR.
 */

export const REVOLUT_SAVE_CARD_VERIFICATION_MINOR = 100;

export type BookingPreauthAmountGuardResult =
  | { ok: true; authorisedAmountPence: number }
  | {
    ok: false;
    code:
      | "INVALID_BOOKING_FARE"
      | "INVALID_AUTHORISED_AMOUNT"
      | "VERIFICATION_AMOUNT_FOR_BOOKING"
      | "HOLD_BELOW_FARE";
    message: string;
  };

/**
 * Fail closed when the hold looks like a vault verification (£1) while the
 * booking fare SSOT is higher, or when amounts are missing/invalid.
 */
export function assertBookingPreauthAmount(args: {
  estimatedTotalPence: number;
  authorisedAmountPence: number;
}): BookingPreauthAmountGuardResult {
  const fare = Math.round(Number(args.estimatedTotalPence) || 0);
  const authorised = Math.round(Number(args.authorisedAmountPence) || 0);

  if (!Number.isFinite(fare) || fare <= 0) {
    return {
      ok: false,
      code: "INVALID_BOOKING_FARE",
      message: "Booking fare is missing or invalid. No payment was created.",
    };
  }
  if (!Number.isFinite(authorised) || authorised <= 0) {
    return {
      ok: false,
      code: "INVALID_AUTHORISED_AMOUNT",
      message: "Authorisation amount is missing or invalid. No payment was created.",
    };
  }
  if (
    authorised === REVOLUT_SAVE_CARD_VERIFICATION_MINOR &&
    fare > REVOLUT_SAVE_CARD_VERIFICATION_MINOR
  ) {
    return {
      ok: false,
      code: "VERIFICATION_AMOUNT_FOR_BOOKING",
      message:
        "Cannot use card-verification amount for booking. Use real-fare preauth.",
    };
  }
  if (authorised < fare) {
    return {
      ok: false,
      code: "HOLD_BELOW_FARE",
      message: "Authorisation amount is below the booking fare. No payment was created.",
    };
  }
  return { ok: true, authorisedAmountPence: authorised };
}
