/**
 * Customer booking payment workflow SSOT — edge functions.
 * Admin UI mirrors this in src/lib/customerPaymentWorkflow.ts.
 */

import type { GatewayCheckResult } from "./paymentGatewayGuard.ts";
import { PROVIDER_NOT_IMPLEMENTED } from "./paymentGatewayGuard.ts";

export type CustomerBookingWorkflow = "stripe_preauth" | "mobile_wallet_collect" | "blocked";

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

/** Provider id → default mobile wallet methods for that gateway. */
export const PROVIDER_MOBILE_WALLET_CATALOG: Record<string, MobileWalletMethodId[]> = {
  sifalo_pay: ["evc_plus", "zaad", "taaj", "sahal_pay", "waafi_pay", "premier_bank"],
  intasend: ["mpesa"],
  waafi_pay: ["waafi_pay"],
  sahal_pay: ["sahal_pay"],
};

/** Providers with live customer booking adapters (card preauth or mobile collect). */
export const LIVE_CUSTOMER_BOOKING_PROVIDERS = new Set<string>(["stripe", "revolut"]);

/** Providers with live driver payout adapters (Stripe Connect, Revolut Business, etc.). */
export const LIVE_DRIVER_PAYOUT_PROVIDERS = new Set<string>(["stripe", "revolut"]);

export function isMobileWalletCollectProvider(provider: string | null | undefined): boolean {
  if (!provider) return false;
  return provider in PROVIDER_MOBILE_WALLET_CATALOG;
}

export function isStripePreauthProvider(provider: string | null | undefined): boolean {
  return provider === "stripe";
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

export function resolveCustomerBookingWorkflow(
  gatewayCheck: GatewayCheckResult,
): CustomerBookingWorkflow {
  if (!gatewayCheck.ok) return "blocked";
  if (isStripePreauthProvider(gatewayCheck.provider)) return "stripe_preauth";
  if (isMobileWalletCollectProvider(gatewayCheck.provider)) return "mobile_wallet_collect";
  return "blocked";
}

export function enrichCustomerGatewayPayloadForBooking(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const provider = payload.provider as string | null;
  if (!provider) return payload;

  if (isCustomerBookingAdapterLive(provider)) {
    if (payload.ready_for_production === true) {
      return { ...payload, code: null };
    }
    return payload;
  }

  const credentialsStored =
    payload.configured === true ||
    (payload.health as { api_keys_configured?: boolean } | undefined)?.api_keys_configured === true;

  if (credentialsStored) {
    return {
      ...payload,
      code: PROVIDER_NOT_IMPLEMENTED,
      message:
        `${(payload.display_name as string) ?? provider} is registered but not yet enabled for live booking`,
    };
  }

  return payload;
}

export function resolveEnabledMobileWalletMethods(
  provider: string | null,
  saRowMobileMethods: unknown,
): MobileWalletMethodId[] {
  const catalog = provider ? PROVIDER_MOBILE_WALLET_CATALOG[provider] ?? [] : [];
  if (!Array.isArray(saRowMobileMethods) || saRowMobileMethods.length === 0) {
    return catalog;
  }
  const enabled = new Set(saRowMobileMethods.map((v) => String(v)));
  return catalog.filter((id) => enabled.has(id));
}

export type EnabledPaymentMethodsSnake = {
  card: boolean;
  apple_pay: boolean;
  google_pay: boolean;
  cash: boolean;
  wallet: boolean;
};

export type PaymentMethodsCamel = {
  cash: boolean;
  card: boolean;
  wallet: boolean;
  applePay: boolean;
  googlePay: boolean;
};

export function buildServiceAreaPaymentMethodFlags(
  pm: Record<string, unknown> | null,
  gatewayCheck: GatewayCheckResult,
): {
  paymentMethods: PaymentMethodsCamel | null;
  enabled_payment_methods: EnabledPaymentMethodsSnake | null;
  enabled_mobile_wallet_methods: MobileWalletMethodId[] | null;
  booking_workflow: CustomerBookingWorkflow;
} {
  const workflow = resolveCustomerBookingWorkflow(gatewayCheck);
  if (!pm) {
    return {
      paymentMethods: null,
      enabled_payment_methods: null,
      enabled_mobile_wallet_methods: null,
      booking_workflow: workflow,
    };
  }

  const provider = gatewayCheck.ok ? gatewayCheck.provider : null;
  const isStripe = gatewayCheck.ok && isStripePreauthProvider(provider);
  const isMobile = gatewayCheck.ok && isMobileWalletCollectProvider(provider);
  const cash = false;

  const paymentMethods: PaymentMethodsCamel = {
    cash,
    card: isStripe ? Boolean(pm.card_enabled) : false,
    wallet: isStripe ? Boolean(pm.wallet_enabled) : false,
    applePay: isStripe ? Boolean(pm.apple_pay_enabled) : false,
    googlePay: isStripe ? Boolean(pm.google_pay_enabled) : false,
  };

  const enabled_payment_methods: EnabledPaymentMethodsSnake = {
    card: paymentMethods.card,
    apple_pay: paymentMethods.applePay,
    google_pay: paymentMethods.googlePay,
    cash,
    wallet: paymentMethods.wallet,
  };

  const enabled_mobile_wallet_methods = isMobile
    ? resolveEnabledMobileWalletMethods(provider, pm.mobile_wallet_methods)
    : null;

  return {
    paymentMethods,
    enabled_payment_methods,
    enabled_mobile_wallet_methods,
    booking_workflow: workflow,
  };
}

/** Mobile-wallet booking edges — adapter must be live. */
export function assertMobileWalletBookingExecutable(
  check: GatewayCheckResult,
): GatewayCheckResult {
  if (!check.ok) return check;
  if (!isMobileWalletCollectProvider(check.provider)) {
    return {
      ok: false,
      code: PROVIDER_NOT_IMPLEMENTED,
      role: "customer",
      provider: check.provider,
      reason: "Service area does not use a mobile wallet payment gateway",
    };
  }
  if (!isCustomerBookingAdapterLive(check.provider)) {
    return {
      ok: false,
      code: PROVIDER_NOT_IMPLEMENTED,
      role: "customer",
      provider: check.provider,
      reason: `${check.display_name} is registered but not yet enabled for live booking`,
    };
  }
  return check;
}
