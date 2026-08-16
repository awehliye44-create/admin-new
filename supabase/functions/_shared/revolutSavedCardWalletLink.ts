/**
 * Revolut saved-card token capture / wallet link helpers.
 * Stripe wallet-card linking is retired — tokens stay on Revolut platform ids.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import type { ProviderEnvironment } from "./paymentProviders/types.ts";
import {
  captureRevolutProviderTokenFromOrder,
} from "./customerSavedPaymentMethodTokens.ts";

export const ONECAB_PENDING_PLATFORM_PM_PREFIX = "oc_pm_";

export function isPendingPlatformPaymentMethodId(id: string | null | undefined): boolean {
  return String(id ?? "").startsWith(ONECAB_PENDING_PLATFORM_PM_PREFIX);
}

/**
 * @deprecated Stripe wallet link retired. Returns the Revolut platform id unchanged.
 */
export async function linkRevolutTokenToStripeWalletCard(
  _supabase: SupabaseClient,
  _stripe: unknown,
  args: {
    userId: string;
    stripeCustomerId?: string;
    platformPaymentMethodId: string;
    providerPaymentMethodId: string;
    brand?: string | null;
    last4?: string | null;
    expMonth?: number | null;
    expYear?: number | null;
  },
): Promise<string> {
  return String(args.platformPaymentMethodId ?? "").trim();
}

export async function finalizeRevolutTokenCapture(
  supabase: SupabaseClient,
  args: {
    environment: ProviderEnvironment;
    secretKey: string;
    orderId: string;
    userId: string;
    orderMetadata?: Record<string, string | undefined> | null;
    platformPaymentMethodId?: string | null;
    markFailedOnMiss?: boolean;
    pollProfile?: "booking" | "setup";
    /** @deprecated ignored — Stripe wallet link retired */
    stripe?: unknown;
    /** @deprecated ignored — Stripe wallet link retired */
    stripeCustomerId?: string | null;
  },
): Promise<{
  captured: boolean;
  providerPaymentMethodId?: string;
  platformPaymentMethodId?: string | null;
  tokenizationFailed?: boolean;
}> {
  return captureRevolutProviderTokenFromOrder(supabase, {
    environment: args.environment,
    secretKey: args.secretKey,
    orderId: args.orderId,
    userId: args.userId,
    platformPaymentMethodId: args.platformPaymentMethodId,
    orderMetadata: args.orderMetadata,
    markFailedOnMiss: args.markFailedOnMiss,
    pollProfile: args.pollProfile,
  });
}

export function buildTokenOnlyWalletCards(
  tokenRows: Array<{
    platform_payment_method_id: string;
    provider_payment_method_id: string;
    brand?: string | null;
    last4?: string | null;
    exp_month?: number | null;
    exp_year?: number | null;
    revolut_verified?: boolean | null;
    verified_at?: string | null;
    tokenization_status?: string | null;
  }>,
  existingPlatformCardIds: Set<string>,
): Array<Record<string, unknown>> {
  return tokenRows
    .filter((row) => {
      if (existingPlatformCardIds.has(row.platform_payment_method_id)) return false;
      if (row.tokenization_status === "tokenization_failed") return false;
      const ref = String(row.provider_payment_method_id ?? "").trim();
      if (!ref) return false;
      return row.tokenization_status === "verified" || row.revolut_verified === true;
    })
    .map((row, index) => ({
      id: row.platform_payment_method_id,
      brand: row.brand ?? "card",
      last4: row.last4 ?? "****",
      exp_month: row.exp_month ?? undefined,
      exp_year: row.exp_year ?? undefined,
      is_default: index === 0,
      payment_provider: "revolut",
      vault_provider: "revolut",
      provider_tokens: { revolut: row.provider_payment_method_id },
      provider_reference: row.provider_payment_method_id,
      revolut_verified: true,
      verified_at: row.verified_at ?? null,
      tokenization_failed: false,
    }));
}
