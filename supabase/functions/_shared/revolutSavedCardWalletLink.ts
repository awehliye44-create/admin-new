/**
 * Link Revolut saved-card tokens to ONECAB wallet platform ids (Stripe pm_*).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import type Stripe from "npm:stripe@18.5.0";
import type { ProviderEnvironment } from "./paymentProviders/types.ts";
import {
  captureRevolutProviderTokenFromOrder,
  upsertProviderPaymentMethodToken,
} from "./customerSavedPaymentMethodTokens.ts";

export const ONECAB_PENDING_PLATFORM_PM_PREFIX = "oc_pm_";

export function isPendingPlatformPaymentMethodId(id: string | null | undefined): boolean {
  return String(id ?? "").startsWith(ONECAB_PENDING_PLATFORM_PM_PREFIX);
}

/**
 * After save-card capture, prefer an existing Stripe wallet card with matching last4
 * so list-saved-cards and booking preauth share one platform_payment_method_id.
 */
export async function linkRevolutTokenToStripeWalletCard(
  supabase: SupabaseClient,
  stripe: Stripe,
  args: {
    userId: string;
    stripeCustomerId: string;
    platformPaymentMethodId: string;
    providerPaymentMethodId: string;
    brand?: string | null;
    last4?: string | null;
    expMonth?: number | null;
    expYear?: number | null;
  },
): Promise<string> {
  const platformId = args.platformPaymentMethodId.trim();
  if (!platformId || !isPendingPlatformPaymentMethodId(platformId)) {
    return platformId;
  }

  const last4 = String(args.last4 ?? "").trim();
  if (!last4) return platformId;

  const paymentMethods = await stripe.paymentMethods.list({
    customer: args.stripeCustomerId,
    type: "card",
    limit: 10,
  });

  const match = paymentMethods.data.find((pm) => pm.card?.last4 === last4);
  if (!match?.id) return platformId;

  const linked = await upsertProviderPaymentMethodToken(supabase, {
    userId: args.userId,
    platformPaymentMethodId: match.id,
    paymentProvider: "revolut",
    providerPaymentMethodId: args.providerPaymentMethodId,
    brand: args.brand ?? match.card?.brand ?? null,
    last4: match.card?.last4 ?? last4,
    expMonth: args.expMonth ?? match.card?.exp_month ?? null,
    expYear: args.expYear ?? match.card?.exp_year ?? null,
    tokenizationStatus: "verified",
  });

  if (!linked) return platformId;

  await supabase
    .from("customer_saved_payment_method_tokens")
    .delete()
    .eq("user_id", args.userId)
    .eq("platform_payment_method_id", platformId)
    .eq("payment_provider", "revolut");

  console.info("[revolutSavedCardWalletLink] linked Revolut token to Stripe wallet card", {
    fromPlatformId: platformId,
    toPlatformId: match.id,
    last4,
    providerPaymentMethodId: args.providerPaymentMethodId,
  });

  return match.id;
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
    stripe?: Stripe | null;
    stripeCustomerId?: string | null;
  },
): Promise<{
  captured: boolean;
  providerPaymentMethodId?: string;
  platformPaymentMethodId?: string | null;
  tokenizationFailed?: boolean;
}> {
  const capture = await captureRevolutProviderTokenFromOrder(supabase, {
    environment: args.environment,
    secretKey: args.secretKey,
    orderId: args.orderId,
    userId: args.userId,
    platformPaymentMethodId: args.platformPaymentMethodId,
    orderMetadata: args.orderMetadata,
    markFailedOnMiss: args.markFailedOnMiss,
  });

  if (
    !capture.captured
    || !capture.providerPaymentMethodId
    || !capture.platformPaymentMethodId
    || !args.stripe
    || !args.stripeCustomerId
  ) {
    return capture;
  }

  const linkedPlatformId = await linkRevolutTokenToStripeWalletCard(
    supabase,
    args.stripe,
    {
      userId: args.userId,
      stripeCustomerId: args.stripeCustomerId,
      platformPaymentMethodId: capture.platformPaymentMethodId,
      providerPaymentMethodId: capture.providerPaymentMethodId,
      brand: capture.brand,
      last4: capture.last4,
      expMonth: capture.expMonth,
      expYear: capture.expYear,
    },
  );

  return {
    ...capture,
    platformPaymentMethodId: linkedPlatformId,
  };
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
  existingStripeCardIds: Set<string>,
): Array<Record<string, unknown>> {
  return tokenRows
    .filter((row) => {
      if (existingStripeCardIds.has(row.platform_payment_method_id)) return false;
      if (row.tokenization_status === "tokenization_failed") return false;
      const ref = String(row.provider_payment_method_id ?? "").trim();
      if (!ref) return false;
      const status = String(row.tokenization_status ?? "");
      return status === "verified" || status === "active" || row.revolut_verified === true;
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
