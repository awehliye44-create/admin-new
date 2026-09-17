import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import type { ProviderEnvironment } from "./paymentProviders/types.ts";
import { loadPaymentSession } from "./paymentSessionSSOT.ts";
import {
  extractRevolutSavedCardPaymentMethodId,
  listRevolutCustomerPaymentMethods,
  listRevolutOrderPayments,
  type RevolutOrderPayment,
} from "./revolutOrders.ts";
import { ONECAB_PENDING_PLATFORM_PM_PREFIX } from "./revolutSavedCardWalletLink.ts";

/** Short poll — never block Book→Finding when save was not requested. */
export const REVOLUT_TOKEN_CAPTURE_BOOKING_POLL_MS = [0, 100, 250, 500] as const;
/**
 * Save-card / save-eligible booking capture. Sum of sleeps ~6.3s.
 * Used from waitUntil / post-commit so Finding is not gated.
 */
export const REVOLUT_TOKEN_CAPTURE_SETUP_POLL_MS = [0, 400, 900, 1800, 3200] as const;
/**
 * After setup miss, one durable retry wave (~13s more sleep) before mark-failed.
 * Still far below the retired ~82s ladder.
 */
export const REVOLUT_TOKEN_CAPTURE_DURABLE_RETRY_MS = [5000, 8000] as const;

export { ONECAB_PENDING_PLATFORM_PM_PREFIX };

export type TokenizationStatus =
  | "pending"
  | "active"
  | "verified"
  | "tokenization_failed"
  | "removed";

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
    if (status !== "verified" && row.revolut_verified !== true) return null;
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
    providerCustomerId?: string | null;
    verifiedAt?: string | null;
    tokenizationStatus?: TokenizationStatus;
  },
): Promise<boolean> {
  const now = new Date().toISOString();
  const verifiedAt = args.verifiedAt ?? now;
  const tokenizationStatus = args.tokenizationStatus
    ?? (args.paymentProvider === "revolut" ? "verified" : "pending");
  const providerPaymentMethodId = args.providerPaymentMethodId.trim();
  if (!providerPaymentMethodId) return false;

  // Idempotent uniqueness: same provider reusable ref must not create duplicate cards.
  const { data: existingByProvider } = await supabase
    .from("customer_saved_payment_method_tokens")
    .select("platform_payment_method_id")
    .eq("user_id", args.userId)
    .eq("payment_provider", args.paymentProvider)
    .eq("provider_payment_method_id", providerPaymentMethodId)
    .maybeSingle();

  const platformPaymentMethodId =
    String(existingByProvider?.platform_payment_method_id ?? "").trim()
    || args.platformPaymentMethodId.trim();

  if (
    existingByProvider?.platform_payment_method_id
    && existingByProvider.platform_payment_method_id !== args.platformPaymentMethodId
  ) {
    console.info("[customerSavedPaymentMethodTokens] payment_method.already_exists", {
      user_id_suffix: args.userId.length > 8 ? args.userId.slice(-8) : args.userId,
      provider_pm_suffix: providerPaymentMethodId.length > 8
        ? providerPaymentMethodId.slice(-8)
        : providerPaymentMethodId,
      platform_payment_method_id: platformPaymentMethodId,
    });
  }

  const revolutVerified =
    args.paymentProvider === "revolut"
    && tokenizationStatus === "verified"
    && Boolean(providerPaymentMethodId);
  const { error } = await supabase
    .from("customer_saved_payment_method_tokens")
    .upsert({
      user_id: args.userId,
      platform_payment_method_id: platformPaymentMethodId,
      payment_provider: args.paymentProvider,
      provider_payment_method_id: providerPaymentMethodId,
      brand: args.brand ?? null,
      last4: args.last4 ?? null,
      exp_month: args.expMonth ?? null,
      exp_year: args.expYear ?? null,
      provider_customer_id: args.providerCustomerId ?? null,
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
  console.info("[customerSavedPaymentMethodTokens] payment_method.persisted", {
    user_id_suffix: args.userId.length > 8 ? args.userId.slice(-8) : args.userId,
    provider_pm_suffix: providerPaymentMethodId.length > 8
      ? providerPaymentMethodId.slice(-8)
      : providerPaymentMethodId,
    platform_pm_suffix: platformPaymentMethodId.length > 8
      ? platformPaymentMethodId.slice(-8)
      : platformPaymentMethodId,
    tokenization_status: tokenizationStatus,
  });
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
  const alreadyVerified =
    existing?.tokenization_status === "verified"
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

function readCardExpiry(paymentMethod: Record<string, unknown> | null | undefined): {
  expMonth: number | null;
  expYear: number | null;
} {
  if (!paymentMethod) return { expMonth: null, expYear: null };
  const monthRaw = paymentMethod.card_expiry_month
    ?? paymentMethod.expiry_month
    ?? paymentMethod.exp_month;
  const yearRaw = paymentMethod.card_expiry_year
    ?? paymentMethod.expiry_year
    ?? paymentMethod.exp_year;
  const expMonth = typeof monthRaw === "number" ? monthRaw : Number(monthRaw);
  const expYear = typeof yearRaw === "number" ? yearRaw : Number(yearRaw);
  return {
    expMonth: Number.isFinite(expMonth) && expMonth > 0 ? expMonth : null,
    expYear: Number.isFinite(expYear) && expYear > 0 ? expYear : null,
  };
}

function classifyCaptureMiss(input: {
  paymentCount: number;
  sawOneTimePaymentMethodId: boolean;
  sawReusableSavedMethodId: boolean;
}): string {
  if (input.sawReusableSavedMethodId) return "captured";
  if (input.paymentCount <= 0) return "no_payments_on_order";
  if (input.sawOneTimePaymentMethodId) return "one_time_payment_method_id_not_reusable";
  return "saved_payment_method_id_missing";
}

function cardFingerprintFromPayment(payment: RevolutOrderPayment): {
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
} {
  const expiry = readCardExpiry(
    (payment.payment_method ?? null) as Record<string, unknown> | null,
  );
  return {
    brand: payment.payment_method?.card_brand ?? null,
    last4: payment.payment_method?.card_last_four
      ?? payment.payment_method?.last_four
      ?? null,
    expMonth: expiry.expMonth,
    expYear: expiry.expYear,
  };
}

type CaptureSuccess = {
  captured: true;
  providerPaymentMethodId: string;
  platformPaymentMethodId: string;
  brand?: string | null;
  last4?: string | null;
  expMonth?: number | null;
  expYear?: number | null;
};

async function persistCapturedToken(
  supabase: SupabaseClient,
  args: {
    userId: string;
    platformPmId: string;
    orderId: string;
    savedPmId: string;
    brand?: string | null;
    last4?: string | null;
    expMonth?: number | null;
    expYear?: number | null;
    providerCustomerId?: string | null;
    source: string;
  },
): Promise<CaptureSuccess | null> {
  const ok = await upsertProviderPaymentMethodToken(supabase, {
    userId: args.userId,
    platformPaymentMethodId: args.platformPmId,
    paymentProvider: "revolut",
    providerPaymentMethodId: args.savedPmId,
    brand: args.brand ?? null,
    last4: args.last4 ?? null,
    expMonth: args.expMonth ?? null,
    expYear: args.expYear ?? null,
    providerCustomerId: args.providerCustomerId ?? null,
    tokenizationStatus: "verified",
  });
  if (!ok) return null;
  console.info("[customerSavedPaymentMethodTokens] Revolut token captured", {
    orderId: args.orderId,
    platformPaymentMethodId: args.platformPmId,
    providerPaymentMethodId: args.savedPmId,
    source: args.source,
  });
  return {
    captured: true,
    providerPaymentMethodId: args.savedPmId,
    platformPaymentMethodId: args.platformPmId,
    brand: args.brand ?? null,
    last4: args.last4 ?? null,
    expMonth: args.expMonth ?? null,
    expYear: args.expYear ?? null,
  };
}

/**
 * When order payments never expose nested saved_payment_method.id (common lag on
 * preauth), fall back to the Revolut customer payment-method list and match the
 * card fingerprint from the authorised payment. Never stores payment_method.id.
 */
async function tryCaptureFromCustomerPaymentMethods(
  supabase: SupabaseClient,
  args: {
    environment: ProviderEnvironment;
    secretKey: string;
    orderId: string;
    userId: string;
    platformPmId: string;
    hintBrand?: string | null;
    hintLast4?: string | null;
    hintExpMonth?: number | null;
    hintExpYear?: number | null;
  },
): Promise<CaptureSuccess | null> {
  const { data: customerRow } = await supabase
    .from("customers")
    .select("revolut_customer_id")
    .eq("user_id", args.userId)
    .maybeSingle();
  const revolutCustomerId = String(customerRow?.revolut_customer_id ?? "").trim();
  if (!revolutCustomerId) return null;

  let methods;
  try {
    methods = await listRevolutCustomerPaymentMethods(
      args.environment,
      args.secretKey,
      revolutCustomerId,
    );
  } catch (err) {
    console.warn("[customerSavedPaymentMethodTokens] customer PM list failed", {
      orderId: args.orderId,
      error: String(err),
    });
    return null;
  }

  const hintLast4 = String(args.hintLast4 ?? "").replace(/\D/g, "").slice(-4);
  const hintBrand = String(args.hintBrand ?? "").trim().toLowerCase();
  const existing = await listProviderTokensForUser(supabase, args.userId);
  const existingIds = new Set(
    existing.map((row) => String(row.provider_payment_method_id ?? "").trim()).filter(Boolean),
  );
  const candidates = methods.filter((m) => {
    const id = String(m.id ?? "").trim();
    if (!id || existingIds.has(id)) return false;
    const type = String(m.type ?? "card").toLowerCase();
    if (type && type !== "card") return false;
    if (!hintLast4) return false;
    const details = (m.method_details ?? {}) as Record<string, unknown>;
    const last4 = String(details.last4 ?? details.card_last_four ?? "")
      .replace(/\D/g, "")
      .slice(-4);
    if (last4 && last4 !== hintLast4) return false;
    if (hintBrand) {
      const brand = String(details.brand ?? details.card_brand ?? "").trim().toLowerCase();
      if (brand && !brand.includes(hintBrand) && !hintBrand.includes(brand)) return false;
    }
    return true;
  });
  if (candidates.length === 0) return null;

  // Prefer exact last4 match; otherwise last listed (Revolut returns newest-first typically).
  const match = candidates[candidates.length - 1]!;
  const details = (match.method_details ?? {}) as Record<string, unknown>;
  const expMonthRaw = details.expiry_month ?? details.exp_month;
  const expYearRaw = details.expiry_year ?? details.exp_year;
  const expMonth = typeof expMonthRaw === "number" ? expMonthRaw : Number(expMonthRaw);
  const expYear = typeof expYearRaw === "number" ? expYearRaw : Number(expYearRaw);

  return persistCapturedToken(supabase, {
    userId: args.userId,
    platformPmId: args.platformPmId,
    orderId: args.orderId,
    savedPmId: String(match.id).trim(),
    brand: String(details.brand ?? args.hintBrand ?? "").trim() || null,
    last4: String(details.last4 ?? args.hintLast4 ?? "").replace(/\D/g, "").slice(-4) || null,
    expMonth: Number.isFinite(expMonth) && expMonth > 0 ? expMonth : args.hintExpMonth ?? null,
    expYear: Number.isFinite(expYear) && expYear > 0 ? expYear : args.hintExpYear ?? null,
    providerCustomerId: revolutCustomerId,
    source: "customer_payment_methods_fallback",
  });
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
    /**
     * booking: short poll — never block Book→Finding when save was not requested.
     * setup: save-card / save-eligible booking (waitUntil / post-commit); ~6.3s + durable retry.
     */
    pollProfile?: "booking" | "setup";
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
  const platformPmId = await resolvePlatformPaymentMethodIdForOrder(supabase, {
    orderId: args.orderId,
    platformPaymentMethodId: args.platformPaymentMethodId,
    orderMetadata: args.orderMetadata,
  });
  if (!platformPmId) {
    console.warn("[customerSavedPaymentMethodTokens] capture skipped — no platform PM id", {
      orderId: args.orderId,
      purpose: args.orderMetadata?.purpose ?? null,
    });
    return { captured: false };
  }

  const useSetupProfile = args.pollProfile === "setup";
  // Sum of sleeps: booking ~0.85s; setup ~6.3s (+ durable ~13s). Never reintroduce ~82s.
  const pollDelaysMs: number[] = [
    ...(useSetupProfile
      ? REVOLUT_TOKEN_CAPTURE_SETUP_POLL_MS
      : REVOLUT_TOKEN_CAPTURE_BOOKING_POLL_MS),
    ...(useSetupProfile ? REVOLUT_TOKEN_CAPTURE_DURABLE_RETRY_MS : []),
  ];
  let paymentCount = 0;
  let sawOneTimePaymentMethodId = false;
  let sawReusableSavedMethodId = false;
  let hintBrand: string | null = null;
  let hintLast4: string | null = null;
  let hintExpMonth: number | null = null;
  let hintExpYear: number | null = null;
  let revolutCustomerId: string | null = null;

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
      paymentCount += 1;
      const oneTimeId = String(payment.payment_method?.id ?? "").trim();
      if (oneTimeId) sawOneTimePaymentMethodId = true;
      const fingerprint = cardFingerprintFromPayment(payment);
      if (fingerprint.last4) {
        hintBrand = fingerprint.brand;
        hintLast4 = fingerprint.last4;
        hintExpMonth = fingerprint.expMonth;
        hintExpYear = fingerprint.expYear;
      }
      const savedPmId = extractRevolutSavedCardPaymentMethodId(payment);
      if (!savedPmId) continue;
      sawReusableSavedMethodId = true;
      const cardPm = payments.find((row) => row.payment_method?.type === "card") ?? payment;
      const cardFp = cardFingerprintFromPayment(cardPm);
      if (!revolutCustomerId) {
        const { data: customerRow } = await supabase
          .from("customers")
          .select("revolut_customer_id")
          .eq("user_id", args.userId)
          .maybeSingle();
        revolutCustomerId = String(customerRow?.revolut_customer_id ?? "").trim() || null;
      }
      const persisted = await persistCapturedToken(supabase, {
        userId: args.userId,
        platformPmId,
        orderId: args.orderId,
        savedPmId,
        brand: cardFp.brand,
        last4: cardFp.last4,
        expMonth: cardFp.expMonth,
        expYear: cardFp.expYear,
        providerCustomerId: revolutCustomerId,
        source: "order_payments",
      });
      if (persisted) return persisted;
    }

    // Mid-ladder fallback: Revolut may attach the reusable method to the customer
    // before nested saved_payment_method.id appears on order payments.
    if (useSetupProfile) {
      const fromCustomer = await tryCaptureFromCustomerPaymentMethods(supabase, {
        environment: args.environment,
        secretKey: args.secretKey,
        orderId: args.orderId,
        userId: args.userId,
        platformPmId,
        hintBrand,
        hintLast4,
        hintExpMonth,
        hintExpYear,
      });
      if (fromCustomer) return fromCustomer;
    }
  }

  const missReason = classifyCaptureMiss({
    paymentCount,
    sawOneTimePaymentMethodId,
    sawReusableSavedMethodId,
  });
  console.warn("[customerSavedPaymentMethodTokens] no reusable Revolut reference on order", {
    orderId: args.orderId,
    platformPaymentMethodId: platformPmId,
    reason: missReason,
    paymentCount,
    sawOneTimePaymentMethodId,
    pollProfile: args.pollProfile ?? "booking",
  });

  await supabase.from("admin_payment_audit").insert({
    action: "revolut_saved_method_capture_miss",
    provider: "revolut",
    provider_payment_id: args.orderId,
    metadata: {
      platform_payment_method_id: platformPmId,
      reason: missReason,
      payment_count: paymentCount,
      saw_one_time_payment_method_id: sawOneTimePaymentMethodId,
      poll_profile: args.pollProfile ?? "booking",
      note: "payment_method.id is a one-time payment reference and must not be stored as a reusable card.",
    },
  }).then(({ error }) => {
    if (error) {
      console.warn("[customerSavedPaymentMethodTokens] capture-miss audit failed", error.message);
    }
  });

  if (args.markFailedOnMiss) {
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
    return row.tokenization_status === "verified" && row.revolut_verified === true
      && Boolean(row.provider_payment_method_id?.trim());
  });
}
