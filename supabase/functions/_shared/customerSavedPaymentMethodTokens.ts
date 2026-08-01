import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import type { ProviderEnvironment } from "./paymentProviders/types.ts";
import { loadPaymentSession } from "./paymentSessionSSOT.ts";
import {
  extractRevolutSavedCardPaymentMethodId,
  listRevolutOrderPayments,
} from "./revolutOrders.ts";
import { ONECAB_PENDING_PLATFORM_PM_PREFIX } from "./revolutSavedCardWalletLink.ts";

export { ONECAB_PENDING_PLATFORM_PM_PREFIX };

export type TokenizationStatus = "pending" | "verified" | "active" | "tokenization_failed";

export type SavedPaymentMethodTokenRow = {
  id: string;
  user_id: string;
  platform_payment_method_id: string;
  payment_provider: string;
  provider_payment_method_id: string;
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  tokenization_status?: TokenizationStatus | string | null;
  revolut_verified?: boolean | null;
};

export async function lookupProviderPaymentMethodToken(
  supabase: SupabaseClient,
  args: {
    userId: string;
    platformPaymentMethodId: string;
    paymentProvider: string;
  },
): Promise<SavedPaymentMethodTokenRow | null> {
  const { data, error } = await supabase
    .from("customer_saved_payment_method_tokens")
    .select("*")
    .eq("user_id", args.userId)
    .eq("platform_payment_method_id", args.platformPaymentMethodId)
    .eq("payment_provider", args.paymentProvider)
    .maybeSingle();
  if (error) {
    console.warn("[customerSavedPaymentMethodTokens] lookup failed", error.message);
    return null;
  }
  const row = data as SavedPaymentMethodTokenRow | null;
  if (!row) return null;
  if (args.paymentProvider === "revolut") {
    const status = String(row.tokenization_status ?? "");
    if (status === "tokenization_failed") return null;
    if (
      status !== "verified"
      && status !== "active"
      && row.revolut_verified !== true
    ) {
      return null;
    }
  }
  return row;
}

export async function upsertProviderPaymentMethodToken(
  supabase: SupabaseClient,
  args: {
    userId: string;
    platformPaymentMethodId: string;
    paymentProvider: string;
    providerPaymentMethodId: string;
    brand?: string | null;
    last4?: string | null;
    expMonth?: number | null;
    expYear?: number | null;
    verifiedAt?: string | null;
    tokenizationStatus?: TokenizationStatus;
  },
): Promise<boolean> {
  const now = new Date().toISOString();
  const verifiedAt = args.verifiedAt ?? now;
  // Prefer "active" for Revolut so list-revolut-saved-cards matches setup-revolut-card.
  // "verified" remains accepted by list/lookup for older booking-capture rows.
  const tokenizationStatus = args.tokenizationStatus
    ?? (args.paymentProvider === "revolut" ? "active" : "pending");
  const revolutVerified =
    args.paymentProvider === "revolut"
    && (tokenizationStatus === "verified" || tokenizationStatus === "active")
    && Boolean(args.providerPaymentMethodId.trim());
  const { error } = await supabase
    .from("customer_saved_payment_method_tokens")
    .upsert({
      user_id: args.userId,
      platform_payment_method_id: args.platformPaymentMethodId,
      payment_provider: args.paymentProvider,
      provider_payment_method_id: args.providerPaymentMethodId,
      brand: args.brand ?? null,
      last4: args.last4 ?? null,
      exp_month: args.expMonth ?? null,
      exp_year: args.expYear ?? null,
      verified_at: verifiedAt,
      revolut_verified: revolutVerified,
      tokenization_status: tokenizationStatus,
      updated_at: now,
    }, {
      onConflict: "user_id,platform_payment_method_id,payment_provider",
    });
  if (error) {
    console.warn("[customerSavedPaymentMethodTokens] upsert failed", error.message);
    return false;
  }
  return true;
}

export async function markRevolutTokenizationFailed(
  supabase: SupabaseClient,
  args: {
    userId: string;
    platformPaymentMethodId: string;
    orderId?: string | null;
    reason?: string | null;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const { data: existing } = await supabase
    .from("customer_saved_payment_method_tokens")
    .select("id, tokenization_status, provider_payment_method_id, revolut_verified")
    .eq("user_id", args.userId)
    .eq("platform_payment_method_id", args.platformPaymentMethodId)
    .eq("payment_provider", "revolut")
    .maybeSingle();

  const existingRef = String(existing?.provider_payment_method_id ?? "").trim();
  const existingStatus = String(existing?.tokenization_status ?? "");
  const alreadyVerified =
    (existingStatus === "verified" || existingStatus === "active")
    && existing?.revolut_verified === true
    && Boolean(existingRef);

  if (alreadyVerified) {
    console.info("[customerSavedPaymentMethodTokens] skip mark failed — verified token exists", {
      platformPaymentMethodId: args.platformPaymentMethodId,
      providerPaymentMethodId: existingRef,
      orderId: args.orderId ?? null,
      reason: args.reason ?? null,
    });
    return;
  }

  if (existing?.id) {
    await supabase
      .from("customer_saved_payment_method_tokens")
      .update({
        tokenization_status: "tokenization_failed",
        revolut_verified: false,
        updated_at: now,
      })
      .eq("id", existing.id);
  }

  await supabase.from("admin_payment_audit").insert({
    action: "revolut_tokenization_failed",
    provider: "revolut",
    provider_payment_id: args.orderId ?? null,
    metadata: {
      platform_payment_method_id: args.platformPaymentMethodId,
      reason: args.reason ?? "no_saved_payment_method_id_on_order",
    },
  }).then(({ error }) => {
    if (error) console.warn("[customerSavedPaymentMethodTokens] audit failed", error.message);
  });
}

export async function invalidateRevolutProviderToken(
  supabase: SupabaseClient,
  args: {
    userId: string;
    platformPaymentMethodId: string;
    reason?: string | null;
    orderId?: string | null;
  },
): Promise<void> {
  await markRevolutTokenizationFailed(supabase, args);
}

export async function resolvePlatformPaymentMethodIdForOrder(
  supabase: SupabaseClient,
  args: {
    orderId: string;
    platformPaymentMethodId?: string | null;
    orderMetadata?: Record<string, string | undefined> | null;
  },
): Promise<string | null> {
  const direct =
    args.platformPaymentMethodId?.trim()
    ?? args.orderMetadata?.platform_payment_method_id?.trim()
    ?? null;
  if (direct) return direct;

  const session = await loadPaymentSession(supabase, { providerOrderId: args.orderId });
  const fromSession = String(session?.platform_payment_method_id ?? "").trim();
  return fromSession || null;
}

export async function captureRevolutProviderTokenFromOrder(
  supabase: SupabaseClient,
  args: {
    environment: ProviderEnvironment;
    secretKey: string;
    orderId: string;
    userId: string;
    platformPaymentMethodId?: string | null;
    orderMetadata?: Record<string, string | undefined> | null;
    /** When true, mark tokenization_failed if no saved_payment_method.id after poll. */
    markFailedOnMiss?: boolean;
  },
): Promise<{
  captured: boolean;
  providerPaymentMethodId?: string;
  platformPaymentMethodId?: string;
  brand?: string | null;
  last4?: string | null;
  expMonth?: number | null;
  expYear?: number | null;
  tokenizationFailed?: boolean;
}> {
  const resolvedPlatformPmId = await resolvePlatformPaymentMethodIdForOrder(supabase, {
    orderId: args.orderId,
    platformPaymentMethodId: args.platformPaymentMethodId,
    orderMetadata: args.orderMetadata,
  });
  // Booking new-card orders often omit platform_payment_method_id on the session.
  // Allocate a pending ONECAB id only once Revolut returns a reusable saved PM.
  let platformPmId = resolvedPlatformPmId;

  const pollDelaysMs = [0, 400, 900, 1800, 3200, 6000, 10000, 15000, 20000, 25000];
  for (const delayMs of pollDelaysMs) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    let payments;
    try {
      payments = await listRevolutOrderPayments(args.environment, args.secretKey, args.orderId);
    } catch (err) {
      console.warn("[customerSavedPaymentMethodTokens] list payments failed", {
        orderId: args.orderId,
        error: String(err),
      });
      continue;
    }

    for (const payment of payments) {
      const savedPmId = extractRevolutSavedCardPaymentMethodId(payment);
      if (!savedPmId) continue;
      if (!platformPmId) {
        platformPmId = `${ONECAB_PENDING_PLATFORM_PM_PREFIX}${crypto.randomUUID()}`;
        console.info("[customerSavedPaymentMethodTokens] allocated pending platform PM id", {
          orderId: args.orderId,
          platformPaymentMethodId: platformPmId,
        });
      }
      const cardPm = payments.find((row) => row.payment_method?.type === "card") ?? payment;
      // Use "active" so list-revolut-saved-cards matches setup-revolut-card rows.
      const ok = await upsertProviderPaymentMethodToken(supabase, {
        userId: args.userId,
        platformPaymentMethodId: platformPmId,
        paymentProvider: "revolut",
        providerPaymentMethodId: savedPmId,
        brand: cardPm.payment_method?.card_brand ?? null,
        last4: cardPm.payment_method?.card_last_four
          ?? cardPm.payment_method?.last_four
          ?? null,
        tokenizationStatus: "active",
      });
      if (ok) {
        console.info("[customerSavedPaymentMethodTokens] Revolut token captured", {
          orderId: args.orderId,
          platformPaymentMethodId: platformPmId,
          providerPaymentMethodId: savedPmId,
        });
        return {
          captured: true,
          providerPaymentMethodId: savedPmId,
          platformPaymentMethodId: platformPmId,
          brand: cardPm.payment_method?.card_brand ?? null,
          last4: cardPm.payment_method?.card_last_four
            ?? cardPm.payment_method?.last_four
            ?? null,
          expMonth: null,
          expYear: null,
        };
      }
    }
  }

  console.warn("[customerSavedPaymentMethodTokens] no reusable Revolut reference on order", {
    orderId: args.orderId,
    platformPaymentMethodId: platformPmId,
    hadPlatformPmUpfront: Boolean(resolvedPlatformPmId),
  });

  if (args.markFailedOnMiss && platformPmId) {
    await markRevolutTokenizationFailed(supabase, {
      userId: args.userId,
      platformPaymentMethodId: platformPmId,
      orderId: args.orderId,
      reason: "saved_payment_method_id_missing_after_checkout",
    });
    return { captured: false, tokenizationFailed: true };
  }

  return { captured: false };
}

export async function listProviderTokensForUser(
  supabase: SupabaseClient,
  userId: string,
): Promise<SavedPaymentMethodTokenRow[]> {
  const { data, error } = await supabase
    .from("customer_saved_payment_method_tokens")
    .select("*")
    .eq("user_id", userId)
    .neq("tokenization_status", "tokenization_failed");
  if (error) {
    console.warn("[customerSavedPaymentMethodTokens] list failed", error.message);
    return [];
  }
  return ((data as SavedPaymentMethodTokenRow[]) ?? []).filter((row) => {
    if (row.payment_provider !== "revolut") return true;
    const status = String(row.tokenization_status ?? "");
    const okStatus = status === "verified" || status === "active";
    return okStatus && row.revolut_verified === true
      && Boolean(row.provider_payment_method_id?.trim());
  });
}
