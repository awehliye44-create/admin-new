/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Revolut Merchant API credentials — vault SSOT with edge env fallback.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

import { getProviderSecrets } from "../../../functions/_shared/paymentProviders/secretManager.ts";

import { normalizeRevolutMerchantSecret } from "../../../functions/_shared/revolutApi.ts";

import type { ProviderEnvironment } from "../../../functions/_shared/paymentProviders/types.ts";
import { merchantContextCache } from "../../../functions/_shared/revolutMerchantContext.ts";


/** Test helper — clear isolate cache between cases. */
export function __resetRevolutMerchantContextCacheForTests(): void {
  merchantContextCache.clear();
}

export * from "../../../functions/_shared/revolutMerchantContext.ts";
