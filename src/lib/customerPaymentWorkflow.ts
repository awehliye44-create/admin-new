/**
 * Customer booking payment workflow SSOT — admin UI.
 * Keep in sync with onecab-comfy-ride customer + edge modules.
 */

export type MobileWalletMethodId =
  | "evc_plus"
  | "zaad"
  | "taaj"
  | "sahal_pay"
  | "waafi_pay"
  | "mpesa"
  | "premier_bank";

export const MOBILE_WALLET_METHOD_LABELS: Record<MobileWalletMethodId, string> = {
  evc_plus: "EVC Plus",
  zaad: "ZAAD",
  taaj: "Taaj",
  sahal_pay: "Sahal Pay",
  waafi_pay: "WaafiPay",
  mpesa: "M-Pesa",
  premier_bank: "Premier Bank",
};

export const PROVIDER_MOBILE_WALLET_CATALOG: Record<string, MobileWalletMethodId[]> = {
  sifalo_pay: ["evc_plus", "zaad", "taaj", "sahal_pay", "waafi_pay", "premier_bank"],
  intasend: ["mpesa"],
  waafi_pay: ["waafi_pay"],
  sahal_pay: ["sahal_pay"],
};

/** Providers with live customer booking adapters (card preauth or mobile collect). */
export const LIVE_CUSTOMER_BOOKING_PROVIDERS = new Set<string>(["stripe"]);

/** Providers with live driver payout adapters. */
export const LIVE_DRIVER_PAYOUT_PROVIDERS = new Set<string>(["stripe"]);

export const PROVIDER_NOT_IMPLEMENTED_CODE = "PROVIDER_NOT_IMPLEMENTED";

export function isStripePreauthProvider(provider: string | null | undefined): boolean {
  return provider === "stripe";
}

export function isMobileWalletCollectProvider(provider: string | null | undefined): boolean {
  if (!provider) return false;
  return provider in PROVIDER_MOBILE_WALLET_CATALOG;
}

export function isCustomerBookingAdapterLive(provider: string | null | undefined): boolean {
  return Boolean(provider && LIVE_CUSTOMER_BOOKING_PROVIDERS.has(provider));
}

export function isPayoutAdapterLive(provider: string | null | undefined): boolean {
  return Boolean(provider && LIVE_DRIVER_PAYOUT_PROVIDERS.has(provider));
}

export function providerPayoutNotAvailableMessage(
  displayName: string | null | undefined,
  provider: string,
): string {
  const label = displayName?.trim() || provider;
  return `${label} payout setup is not available yet.`;
}

export function resolveProviderBookingAdapterStatus(
  provider: string | null | undefined,
  readyForProduction: boolean,
  configured = false,
): "live" | "not_implemented" | "not_configured" {
  if (!provider) return "not_configured";
  if (isCustomerBookingAdapterLive(provider) && readyForProduction) return "live";
  if (configured && !isCustomerBookingAdapterLive(provider)) return "not_implemented";
  if (!configured && !readyForProduction) return "not_configured";
  if (!isCustomerBookingAdapterLive(provider)) return "not_implemented";
  return "not_configured";
}

export function providerNotImplementedMessage(displayName: string | null, provider: string): string {
  const label = displayName?.trim() || provider;
  return `${label} is registered but not yet enabled for live customer bookings (PROVIDER_NOT_IMPLEMENTED).`;
}

export function catalogMethodsForProvider(provider: string | null): MobileWalletMethodId[] {
  if (!provider) return [];
  return PROVIDER_MOBILE_WALLET_CATALOG[provider] ?? [];
}

export function normalizeMobileWalletMethods(
  provider: string | null,
  raw: unknown,
): MobileWalletMethodId[] {
  const catalog = catalogMethodsForProvider(provider);
  if (!Array.isArray(raw) || raw.length === 0) return catalog;
  const enabled = new Set(raw.map(String));
  return catalog.filter((id) => enabled.has(id));
}
