/**
 * Revolut Merchant customer SSOT — required on orders for savePaymentMethodFor.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { revolutMerchantRequest } from "./revolutApi.ts";
import type { ProviderEnvironment } from "./paymentProviders/types.ts";

export type RevolutCustomerRef = {
  id?: string;
  email: string;
  full_name?: string;
};

type RevolutCustomerResponse = {
  id?: string;
  email?: string;
  full_name?: string;
};

export async function ensureRevolutCustomerForBooking(args: {
  supabase: SupabaseClient;
  environment: ProviderEnvironment;
  secretKey: string;
  userId: string;
  email: string;
  fullName?: string | null;
}): Promise<RevolutCustomerRef | null> {
  const email = args.email.trim().toLowerCase();
  if (!email) return null;

  const { data: customerRow } = await args.supabase
    .from("customers")
    .select("id, revolut_customer_id")
    .eq("user_id", args.userId)
    .maybeSingle();

  const existingId = customerRow?.revolut_customer_id as string | null | undefined;
  if (existingId?.trim()) {
    return {
      id: existingId.trim(),
      email,
      full_name: args.fullName?.trim() || undefined,
    };
  }

  let created: RevolutCustomerResponse;
  try {
    created = await revolutMerchantRequest<RevolutCustomerResponse>(
      args.environment,
      args.secretKey,
      "/customers",
      {
        method: "POST",
        body: JSON.stringify({
          email,
          ...(args.fullName?.trim() ? { full_name: args.fullName.trim() } : {}),
        }),
      },
    );
  } catch (err) {
    console.warn("[revolutCustomers] create failed", {
      userId: args.userId,
      error: String(err),
    });
    return { email, full_name: args.fullName?.trim() || undefined };
  }

  const revolutCustomerId = created.id?.trim();
  if (customerRow?.id && revolutCustomerId) {
    await args.supabase
      .from("customers")
      .update({ revolut_customer_id: revolutCustomerId })
      .eq("id", customerRow.id);
  }

  if (revolutCustomerId) {
    return {
      id: revolutCustomerId,
      email,
      full_name: args.fullName?.trim() || created.full_name || undefined,
    };
  }

  return { email, full_name: args.fullName?.trim() || undefined };
}
