/** Offline test/audit-only helpers; not part of Edge uploads. */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

import {
  cancelRevolutOrder,
  refundRevolutOrder,
  retrieveRevolutOrder,
} from "../../../functions/_shared/revolutOrders.ts";

import { revolutMerchantRequest } from "../../../functions/_shared/revolutApi.ts";

import type { ProviderEnvironment } from "../../../functions/_shared/paymentProviders/types.ts";


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

export * from "../../../functions/_shared/revolutSavedCardVault.ts";
