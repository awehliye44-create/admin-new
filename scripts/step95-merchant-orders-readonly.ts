import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { resolveRevolutMerchantContext } from "../supabase/functions/_shared/revolutMerchantContext.ts";
import { retrieveRevolutOrder } from "../supabase/functions/_shared/revolutOrders.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const auditDir = Deno.env.get("STEP95_AUDIT_DIR")!;
const matches = JSON.parse(await Deno.readTextFile(`${auditDir}/strong_matches.json`));
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const ctx = await resolveRevolutMerchantContext(supabase, "live");

function mask(id: string | null | undefined) {
  const s = String(id ?? "");
  if (s.length < 12) return s ? `${s.slice(0, 2)}…` : null;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

const out = [];
for (const m of matches) {
  const orderId = m.local.provider_order_id as string;
  try {
    const order = await retrieveRevolutOrder(ctx.environment, ctx.secretKey, orderId) as Record<
      string,
      unknown
    >;
    const payments = Array.isArray(order.payments) ? order.payments as Array<Record<string, unknown>> : [];
    const paymentStates = payments.map((p) => ({
      id_masked: mask(String(p.id ?? "")),
      state: p.state ?? null,
      amount: p.amount ?? null,
      authorised_amount: p.authorised_amount ?? null,
    }));
    out.push({
      bank_date: m.bank_date,
      bank_pence: m.bank_pence,
      trip_code: m.trip_code,
      note: m.note ?? null,
      http_ok: true,
      order_id_masked: mask(orderId),
      state: order.state ?? null,
      amount: order.amount ?? null,
      authorised_amount: order.authorised_amount ?? null,
      completed_amount: order.completed_amount ?? null,
      refunded_amount: order.refunded_amount ?? null,
      cancelled_amount: order.cancelled_amount ?? null,
      currency: order.currency ?? null,
      updated_at: order.updated_at ?? order.completed_at ?? null,
      created_at: order.created_at ?? null,
      capture_mode: order.capture_mode ?? null,
      payments: paymentStates,
      release_still_available:
        String(order.state ?? "").toUpperCase() === "AUTHORISED" &&
        Number(order.completed_amount ?? 0) === 0,
      local: m.local,
    });
  } catch (e) {
    out.push({
      bank_date: m.bank_date,
      bank_pence: m.bank_pence,
      trip_code: m.trip_code,
      note: m.note ?? null,
      http_ok: false,
      error: errText(e),
      order_id_masked: mask(orderId),
      local: m.local,
    });
  }
}
await Deno.writeTextFile(`${auditDir}/merchant_gets.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.map((o) => ({
  trip: o.trip_code,
  bank: o.bank_pence,
  ok: o.http_ok,
  state: o.state,
  amount: o.amount,
  authorised: o.authorised_amount,
  completed: o.completed_amount,
  cancelled: o.cancelled_amount,
  refunded: o.refunded_amount,
  release_available: o.release_still_available ?? null,
  err: o.error ?? null,
})), null, 2));
