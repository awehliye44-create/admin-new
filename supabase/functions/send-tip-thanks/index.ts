import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { DRIVER_TIP_THANKS_COPY } from "../_shared/driverTipThanksSSOT.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type DecisionRow = {
  ok: boolean;
  code: string;
  trip_id: string | null;
  passenger_id: string | null;
  sent_at: string | null;
};

async function dispatchCustomerPopup(passengerId: string, thanksId: string) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-customer-notification`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      customer_id: passengerId,
      title: DRIVER_TIP_THANKS_COPY.customerTitle,
      body: DRIVER_TIP_THANKS_COPY.customerBody,
      type: "driver_tip_thanks",
      data: {
        type: "driver_tip_thanks",
        thanks_id: thanksId,
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.warn("[send-tip-thanks] notification not delivered", res.status, text.slice(0, 200));
    return false;
  }
  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, code: "METHOD_NOT_ALLOWED" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) {
    return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  }

  const body = await req.json().catch(() => ({}));
  const ledgerId = String((body as { ledger_id?: unknown }).ledger_id ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(ledgerId)) {
    return json({ ok: false, code: "INVALID_LEDGER_ID" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: driver, error: driverError } = await admin
    .from("drivers")
    .select("id")
    .eq("user_id", userData.user.id)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (driverError || !driver?.id) {
    return json({ ok: false, code: "NOT_OWNER" }, 403);
  }

  const { data: decisionRows, error: decisionError } = await admin.rpc(
    "driver_tip_thanks_decision",
    { p_ledger_id: ledgerId, p_driver_id: driver.id },
  );
  if (decisionError) {
    console.error("[send-tip-thanks] decision failed", decisionError.message);
    return json({ ok: false, code: "DECISION_FAILED" }, 500);
  }
  const decision = (Array.isArray(decisionRows) ? decisionRows[0] : decisionRows) as
    | DecisionRow
    | undefined;
  if (!decision) return json({ ok: false, code: "NOT_FOUND" }, 404);

  if (decision.code === "ALREADY_SENT" || decision.sent_at) {
    return json({
      ok: true,
      status: "already_sent",
      sent_at: decision.sent_at,
    });
  }
  if (!decision.ok || !decision.trip_id || !decision.passenger_id) {
    return json({ ok: false, code: decision.code || "NOT_ELIGIBLE" }, 409);
  }

  const { data: inserted, error: insertError } = await admin
    .from("driver_tip_thanks")
    .insert({
      ledger_id: ledgerId,
      trip_id: decision.trip_id,
      driver_id: driver.id,
    })
    .select("id, sent_at")
    .maybeSingle();

  if (insertError) {
    if (insertError.code === "23505") {
      const { data: existing } = await admin
        .from("driver_tip_thanks")
        .select("sent_at")
        .eq("ledger_id", ledgerId)
        .maybeSingle();
      return json({
        ok: true,
        status: "already_sent",
        sent_at: existing?.sent_at ?? null,
      });
    }
    console.error("[send-tip-thanks] insert failed", insertError.message);
    return json({ ok: false, code: "INSERT_FAILED" }, 500);
  }

  const thanksId = String(inserted?.id ?? "");
  const dispatched = thanksId
    ? await dispatchCustomerPopup(decision.passenger_id, thanksId)
    : false;
  if (dispatched && thanksId) {
    await admin
      .from("driver_tip_thanks")
      .update({ notification_dispatched_at: new Date().toISOString() })
      .eq("id", thanksId);
  }

  return json({
    ok: true,
    status: "sent",
    sent_at: inserted?.sent_at ?? null,
  });
});
