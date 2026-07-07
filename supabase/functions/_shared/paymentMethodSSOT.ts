/**
 * Provider-neutral payment method SSOT — edge functions.
 * Keep in sync with src/lib/paymentMethodSSOT.ts.
 */

import {
  isMobileWalletCollectProvider,
  isRevolutPreauthProvider,
  isStripePreauthProvider,
  MOBILE_WALLET_METHOD_LABELS,
  type MobileWalletMethodId,
} from "./customerPaymentWorkflow.ts";
import type { GatewayStatusSnapshot } from "./paymentGatewayStatus.ts";

/** Phase 2 — Revolut customer tokenisation endpoints. */
export const REVOLUT_SAVE_CARD_TOKENIZATION_READY = false;

export type PaymentMethodKind =
  | "card"
  | "saved_card"
  | "apple_pay"
  | "google_pay"
  | "mobile_wallet"
  | "pay_by_bank"
  | "onecab_wallet";

export type PaymentVaultProvider = "stripe" | "revolut" | "mobile_wallet";

export type MethodReadinessState =
  | "configured"
  | "not_configured"
  | "provider_unsupported"
  | "test"
  | "live";

export type DigitalPaymentMethodRow = {
  method: PaymentMethodKind;
  enabled: boolean;
  readiness: MethodReadinessState;
  provider: string | null;
  vault_provider: PaymentVaultProvider | null;
  environment: "test" | "live" | null;
  message: string | null;
};

export type ServiceAreaPaymentMethodFlags = {
  card: boolean;
  savedCard: boolean;
  applePay: boolean;
  googlePay: boolean;
  mobileWallet: boolean;
  payByBank: boolean;
  onecabWallet: boolean;
};

export type PayoutAutomationStatus =
  | "automated_ready"
  | "manual_ready"
  | "not_configured";

export type MobileWalletPaymentStatus =
  | "pending"
  | "authorised"
  | "captured"
  | "failed";

export type MobileWalletPaymentMethodRecord = {
  payment_method: "mobile_wallet";
  provider: string;
  wallet_network: string;
  wallet_method_id: MobileWalletMethodId;
  account_reference: string | null;
  status: MobileWalletPaymentStatus;
};

export function buildMobileWalletPaymentRecord(args: {
  provider: string;
  walletMethodId: MobileWalletMethodId;
  accountReference?: string | null;
  status?: MobileWalletPaymentStatus;
}): MobileWalletPaymentMethodRecord {
  return {
    payment_method: "mobile_wallet",
    provider: args.provider,
    wallet_network: MOBILE_WALLET_METHOD_LABELS[args.walletMethodId],
    wallet_method_id: args.walletMethodId,
    account_reference: args.accountReference ?? null,
    status: args.status ?? "pending",
  };
}

export function resolvePaymentVaultProvider(
  provider: string | null | undefined,
): PaymentVaultProvider | null {
  if (isStripePreauthProvider(provider)) return "stripe";
  if (isRevolutPreauthProvider(provider)) return "revolut";
  if (isMobileWalletCollectProvider(provider)) return "mobile_wallet";
  return null;
}

export function isSavedCardVaultImplemented(
  vaultProvider: PaymentVaultProvider | null,
): boolean {
  if (!vaultProvider) return false;
  switch (vaultProvider) {
    case "stripe":
      return true;
    case "revolut":
      return REVOLUT_SAVE_CARD_TOKENIZATION_READY;
    case "mobile_wallet":
      return false;
    default:
      return false;
  }
}

export function parseServiceAreaPaymentMethodFlags(
  row: Record<string, unknown> | null | undefined,
  defaults?: Partial<ServiceAreaPaymentMethodFlags>,
): ServiceAreaPaymentMethodFlags {
  const card = row?.card_enabled === true || defaults?.card === true;
  return {
    card,
    savedCard: row?.saved_card_enabled !== false && (row?.saved_card_enabled === true || card),
    applePay: row?.apple_pay_enabled === true,
    googlePay: row?.google_pay_enabled === true,
    mobileWallet: row?.mobile_wallet_enabled === true,
    payByBank: row?.pay_by_bank_enabled === true,
    onecabWallet: row?.wallet_enabled === true,
  };
}

export function resolveMethodReadinessState(args: {
  enabled: boolean;
  providerSupported: boolean;
  configured: boolean;
  environment?: "test" | "live" | null;
}): MethodReadinessState {
  if (!args.enabled) return "not_configured";
  if (!args.providerSupported) return "provider_unsupported";
  if (!args.configured) return "not_configured";
  return args.environment === "test" ? "test" : "live";
}

export function resolveRevolutPayoutAutomationStatus(
  payoutAdapterStatus: string | null | undefined,
  hasBusinessAccountId: boolean,
): PayoutAutomationStatus {
  if (payoutAdapterStatus === "live" && hasBusinessAccountId) return "automated_ready";
  if (hasBusinessAccountId) return "automated_ready";
  return "manual_ready";
}

export function revolutDriverPayoutStatusMessage(
  automation: PayoutAutomationStatus,
): string {
  switch (automation) {
    case "automated_ready":
      return "Automated driver payouts configured (Revolut Business API).";
    case "manual_ready":
      return "Manual payout ready; automated payout not configured (add Source Business account ID).";
    case "not_configured":
      return "Driver payout gateway not configured.";
  }
}

export function buildDigitalPaymentMethodsPayload(args: {
  flags: ServiceAreaPaymentMethodFlags;
  customerGateway: GatewayStatusSnapshot;
  driverGateway: GatewayStatusSnapshot;
  mobileWalletMethods: MobileWalletMethodId[] | null;
  hasRevolutBusinessAccountId?: boolean;
}): {
  methods: DigitalPaymentMethodRow[];
  customer_collection: {
    provider: string | null;
    status: string;
    ready_for_production: boolean;
    booking_adapter_status: string;
    message: string | null;
  };
  driver_payout: {
    provider: string | null;
    status: string;
    payout_adapter_status: string;
    payout_automation: PayoutAutomationStatus;
    message: string;
  };
} {
  const provider = args.customerGateway.provider;
  const vault = resolvePaymentVaultProvider(provider);
  const env = args.customerGateway.environment;
  const collectionReady = args.customerGateway.ready_for_production;
  const vaultImplemented = isSavedCardVaultImplemented(vault);

  const methods: DigitalPaymentMethodRow[] = [
    {
      method: "card",
      enabled: args.flags.card,
      readiness: resolveMethodReadinessState({
        enabled: args.flags.card,
        providerSupported: vault === "stripe" || vault === "revolut",
        configured: collectionReady,
        environment: env,
      }),
      provider,
      vault_provider: vault,
      environment: env,
      message: null,
    },
    {
      method: "saved_card",
      enabled: args.flags.savedCard,
      readiness: resolveMethodReadinessState({
        enabled: args.flags.savedCard,
        providerSupported: vaultImplemented,
        configured: collectionReady && vaultImplemented,
        environment: env,
      }),
      provider,
      vault_provider: vault,
      environment: env,
      message: vaultImplemented
        ? null
        : "Saved card vault not implemented for this provider yet.",
    },
    {
      method: "apple_pay",
      enabled: args.flags.applePay,
      readiness: resolveMethodReadinessState({
        enabled: args.flags.applePay,
        providerSupported: vault === "stripe" || vault === "revolut",
        configured: collectionReady,
        environment: env,
      }),
      provider,
      vault_provider: vault,
      environment: env,
      message: null,
    },
    {
      method: "google_pay",
      enabled: args.flags.googlePay,
      readiness: resolveMethodReadinessState({
        enabled: args.flags.googlePay,
        providerSupported: vault === "stripe" || vault === "revolut",
        configured: collectionReady,
        environment: env,
      }),
      provider,
      vault_provider: vault,
      environment: env,
      message: null,
    },
    {
      method: "mobile_wallet",
      enabled: args.flags.mobileWallet,
      readiness: resolveMethodReadinessState({
        enabled: args.flags.mobileWallet,
        providerSupported: isMobileWalletCollectProvider(provider),
        configured: collectionReady && Boolean(args.mobileWalletMethods?.length),
        environment: env,
      }),
      provider,
      vault_provider: isMobileWalletCollectProvider(provider) ? "mobile_wallet" : null,
      environment: env,
      message: null,
    },
    {
      method: "pay_by_bank",
      enabled: args.flags.payByBank,
      readiness: "provider_unsupported",
      provider,
      vault_provider: null,
      environment: env,
      message: "Pay by bank is not enabled for this area yet.",
    },
    {
      method: "onecab_wallet",
      enabled: args.flags.onecabWallet,
      readiness: resolveMethodReadinessState({
        enabled: args.flags.onecabWallet,
        providerSupported: true,
        configured: true,
        environment: env,
      }),
      provider,
      vault_provider: null,
      environment: env,
      message: null,
    },
  ];

  const payoutAutomation = provider === "revolut"
    ? resolveRevolutPayoutAutomationStatus(
      args.driverGateway.payout_adapter_status,
      args.hasRevolutBusinessAccountId === true,
    )
    : args.driverGateway.payout_adapter_status === "live"
      ? "automated_ready"
      : args.driverGateway.configured
        ? "manual_ready"
        : "not_configured";

  return {
    methods,
    customer_collection: {
      provider: args.customerGateway.provider,
      status: args.customerGateway.status,
      ready_for_production: args.customerGateway.ready_for_production,
      booking_adapter_status: args.customerGateway.booking_adapter_status,
      message: args.customerGateway.message,
    },
    driver_payout: {
      provider: args.driverGateway.provider,
      status: args.driverGateway.status,
      payout_adapter_status: args.driverGateway.payout_adapter_status,
      payout_automation: payoutAutomation,
      message: provider === "revolut"
        ? revolutDriverPayoutStatusMessage(payoutAutomation)
        : (args.driverGateway.message ?? "Driver payout status"),
    },
  };
}
