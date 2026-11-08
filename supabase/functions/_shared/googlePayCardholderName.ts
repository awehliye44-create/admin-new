/**
 * Revolut Pay-for-order Google Pay: sanitised cardholder_name must be > 5 chars.
 * Short Google wallet billing names (e.g. 3-letter given names) otherwise return
 * HTTP 400 → customer sees "Payment wasn't authorised" with no webhooks.
 */

export const GOOGLE_PAY_CARDHOLDER_MIN_SANITISED_CHARS = 6;
export const GOOGLE_PAY_CARDHOLDER_FALLBACK = "Cardholder";

export type GooglePayCardholderSource = "wallet" | "profile" | "fallback";

/** Letters + spaces only after NFKD (matches Revolut-style sanitise length checks). */
export function sanitiseGooglePayCardholderName(
  raw: string | null | undefined,
): string {
  if (typeof raw !== "string") return "";
  const nfkd = raw.normalize("NFKD").replace(/\p{M}/gu, "");
  return nfkd
    .replace(/[^\p{L}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isAcceptableGooglePayCardholderName(
  raw: string | null | undefined,
): boolean {
  return (
    sanitiseGooglePayCardholderName(raw).length >=
    GOOGLE_PAY_CARDHOLDER_MIN_SANITISED_CHARS
  );
}

/**
 * Prefer wallet billing name when Revolut-acceptable; else profile first+last;
 * else the known-good fallback "Cardholder".
 */
export function resolveGooglePayCardholderName(input: {
  walletName?: string | null;
  profileFirstName?: string | null;
  profileLastName?: string | null;
}): { name: string; source: GooglePayCardholderSource } {
  const wallet = typeof input.walletName === "string" ? input.walletName.trim() : "";
  if (wallet && isAcceptableGooglePayCardholderName(wallet)) {
    return { name: wallet, source: "wallet" };
  }

  const profile = [input.profileFirstName, input.profileLastName]
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean)
    .join(" ")
    .trim();
  if (profile && isAcceptableGooglePayCardholderName(profile)) {
    return { name: profile, source: "profile" };
  }

  return { name: GOOGLE_PAY_CARDHOLDER_FALLBACK, source: "fallback" };
}
