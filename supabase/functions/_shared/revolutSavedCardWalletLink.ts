/**
 * Revolut saved-card token capture / wallet link helpers.
 * Tokens stay on Revolut platform payment-method ids.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import type { ProviderEnvironment } from "./paymentProviders/types.ts";
import {
  captureRevolutProviderTokenFromOrder,
} from "./customerSavedPaymentMethodTokens.ts";

export const ONECAB_PENDING_PLATFORM_PM_PREFIX = "oc_pm_";

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
    includeDurableRetry?: boolean;
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
    includeDurableRetry: args.includeDurableRetry,
  });
}

