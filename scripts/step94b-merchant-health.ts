
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { resolveRevolutMerchantContext } from "../supabase/functions/_shared/revolutMerchantContext.ts";
import { retrieveRevolutOrder } from "../supabase/functions/_shared/revolutOrders.ts";
const url = Deno.env.get("SUPABASE_URL")!;
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const auditDir = Deno.env.get("STEP94A_AUDIT_DIR")!;
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const cand = JSON.parse(await Deno.readTextFile(`${auditDir}/merchant_candidates.json`)).rows[0];
const ctx = await resolveRevolutMerchantContext(supabase, "live");
const order = await retrieveRevolutOrder(ctx, cand.provider_order_id);
const out = {
  MERCHANT_API_AUTH_HEALTHY: true,
  order_id_masked: String(cand.provider_order_id).slice(0,8)+"…"+String(cand.provider_order_id).slice(-4),
  state: (order as any).state ?? (order as any).order_status ?? null,
};
await Deno.writeTextFile(`${auditDir}/merchant_health.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
