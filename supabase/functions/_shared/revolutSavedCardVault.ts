import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  cancelRevolutOrder,
  retrieveRevolutOrder,
} from "./revolutOrders.ts";
import { revolutMerchantRequest } from "./revolutApi.ts";
import type { ProviderEnvironment } from "./paymentProviders/types.ts";

export const MAX_SAVED_REVOLUT_CARDS = 2;
export const REVOLUT_SAVE_CARD_VERIFICATION_MINOR = 100;

export type RevolutCustomerPaymentMethod = {
  id: string;
  type: string;
  saved_for?: string;
  method_details?: {
    brand?: string;
    last4?: string;
    expiry_month?: number;
    expiry_year?: number;
    cardholder_name?: string;
  };
};

type CustomerRow = {
  id: string;
  user_id: string;
  revolut_customer_id: string | null;
};

export async function loadCustomerForUser(
  supabase: SupabaseClient,
  userId: string,
): Promise<CustomerRow | null> {
  const { data, error } = await supabase
    .from("customers")
    .select("id, user_id, revolut_customer_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data as CustomerRow | null;
}

export async function ensureRevolutCustomer(args: {
  supabase: SupabaseClient;
  environment: ProviderEnvironment;
  secretKey: string;
  userId: string;
  email: string;
}): Promise<{ customerId: string; revolutCustomerId: string }> {
  const row = await loadCustomerForUser(args.supabase, args.userId);
  if (!row) {
    throw new Error("CUSTOMER_PROFILE_NOT_FOUND");
  }

  if (row.revolut_customer_id) {
    return { customerId: row.id, revolutCustomerId: row.revolut_customer_id };
  }

  const created = await revolutMerchantRequest<{ id: string }>(
    args.environment,
    args.secretKey,
    "/customers",
    {
      method: "POST",
      body: JSON.stringify({
        email: args.email,
        full_name: args.email.split("@")[0] || "ONECAB customer",
      }),
    },
  );

  const revolutCustomerId = String(created.id);
  const { error: updateErr } = await args.supabase
    .from("customers")
    .update({ revolut_customer_id: revolutCustomerId, updated_at: new Date().toISOString() })
    .eq("id", row.id);
  if (updateErr) throw updateErr;

  return { customerId: row.id, revolutCustomerId };
}

export async function createRevolutSaveCardSetupOrder(args: {
  environment: ProviderEnvironment;
  secretKey: string;
  currency: string;
  revolutCustomerId: string;
  customerEmail: string;
  customerUserId: string;
  setupRef: string;
}) {
  return await revolutMerchantRequest<{
    id: string;
    token?: string;
    public_id?: string;
    state?: string;
  }>(
    args.environment,
    args.secretKey,
    "/orders",
    {
      method: "POST",
      body: JSON.stringify({
        amount: REVOLUT_SAVE_CARD_VERIFICATION_MINOR,
        currency: args.currency.toUpperCase(),
        capture_mode: "manual",
        // Card saving is requested by the native SDK (savePaymentMethodFor), not order create.
        customer: {
          id: args.revolutCustomerId,
          email: args.customerEmail,
        },
        merchant_order_ext_ref: `save-card-${args.setupRef}`,
        description: "ONECAB card verification",
        metadata: {
          purpose: "save_card",
          setup_ref: args.setupRef,
          customer_user_id: args.customerUserId,
        },
      }),
    },
  );
}

export async function listRevolutCustomerPaymentMethods(args: {
  environment: ProviderEnvironment;
  secretKey: string;
  revolutCustomerId: string;
}): Promise<RevolutCustomerPaymentMethod[]> {
  const response = await revolutMerchantRequest<{
    payment_methods?: RevolutCustomerPaymentMethod[];
  }>(
    args.environment,
    args.secretKey,
    `/customers/${encodeURIComponent(args.revolutCustomerId)}/payment-methods?only_merchant=false`,
  );
  return Array.isArray(response.payment_methods) ? response.payment_methods : [];
}

export async function deleteRevolutCustomerPaymentMethod(args: {
  environment: ProviderEnvironment;
  secretKey: string;
  revolutCustomerId: string;
  providerPaymentMethodId: string;
}): Promise<void> {
  await revolutMerchantRequest(
    args.environment,
    args.secretKey,
    `/customers/${encodeURIComponent(args.revolutCustomerId)}/payment-methods/${encodeURIComponent(args.providerPaymentMethodId)}`,
    { method: "DELETE" },
  );
}

export function normaliseCardBrand(raw: string | null | undefined): string {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return "Card";
  if (value.includes("visa")) return "Visa";
  if (value.includes("master")) return "Mastercard";
  if (value.includes("amex") || value.includes("american")) return "Amex";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function mapRevolutPaymentMethodToSavedCardRow(args: {
  userId: string;
  platformPaymentMethodId: string;
  method: RevolutCustomerPaymentMethod;
}) {
  const details = args.method.method_details ?? {};
  return {
    user_id: args.userId,
    platform_payment_method_id: args.platformPaymentMethodId,
    payment_provider: "revolut",
    provider_payment_method_id: args.method.id,
    brand: normaliseCardBrand(details.brand),
    last4: String(details.last4 ?? "").slice(-4),
    exp_month: typeof details.expiry_month === "number" ? details.expiry_month : null,
    exp_year: typeof details.expiry_year === "number" ? details.expiry_year : null,
    revolut_verified: true,
    tokenization_status: "active",
    verified_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export async function releaseSaveCardVerificationOrder(args: {
  environment: ProviderEnvironment;
  secretKey: string;
  orderId: string;
}): Promise<void> {
  try {
    const order = await retrieveRevolutOrder(args.environment, args.secretKey, args.orderId);
    const state = String(order.state ?? "").toUpperCase();
    if (state === "AUTHORISED" || state === "PROCESSING" || state === "PENDING") {
      await cancelRevolutOrder(args.environment, args.secretKey, args.orderId);
    }
  } catch (err) {
    console.warn("[revolutSavedCardVault] release verification order failed", err);
  }
}

export async function countSavedRevolutCards(
  supabase: SupabaseClient,
  userId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("customer_saved_payment_method_tokens")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("payment_provider", "revolut");
  if (error) throw error;
  return count ?? 0;
}
