/**
 * Currency symbol SSOT for edge functions.
 * Region config remains the source of truth for the currency code itself.
 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: "£",
  EUR: "€",
  USD: "$",
  AED: "AED ",
  SAR: "SAR ",
  QAR: "QAR ",
  KWD: "KWD ",
  BHD: "BHD ",
  OMR: "OMR ",
  TRY: "₺",
  UGX: "USh ",
  KES: "KSh ",
  TZS: "TSh ",
  NGN: "₦",
  ZAR: "R",
  SOS: "Sh ",
  ETB: "Br ",
  EGP: "E£",
  INR: "₹",
  PKR: "₨",
  CAD: "CA$",
  AUD: "A$",
  CHF: "CHF ",
  SEK: "kr ",
  NOK: "kr ",
  DKK: "kr ",
  PLN: "zł ",
};

export function getCurrencySymbol(currencyCode: string): string {
  if (!currencyCode) return "";
  return CURRENCY_SYMBOLS[currencyCode.toUpperCase()] ?? currencyCode.toUpperCase();
}

export function formatCurrency(amount: number, currencyCode: string): string {
  return `${getCurrencySymbol(currencyCode)}${amount.toFixed(2)}`;
}
