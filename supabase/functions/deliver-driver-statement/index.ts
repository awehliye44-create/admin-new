import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { deliverDriverStatement } from "../_shared/deliverDriverStatement.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function isAdmin(supabase: ReturnType<typeof createClient>, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  return !!data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const isServiceCall = token === serviceKey;
    let sentByUserId: string | null = null;

    const body = await req.json();
    const { action = "deliver", invoice_id, invoice_ids, regenerate_pdf = false } = body;

    const isDeliverAction = action === "deliver";
    const isBackfillAction = action === "backfill";

    if (!isServiceCall && !isDeliverAction) {
      const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const admin = await isAdmin(supabaseAdmin, user.id);
      if (!admin) {
        return new Response(JSON.stringify({ error: "Admin access required" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      sentByUserId = user.id;
    }

    if (isBackfillAction && !isServiceCall && !sentByUserId) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "backfill") {
      const { data: invoices, error } = await supabaseAdmin
        .from("invoices")
        .select("id, driver_id, pdf_storage_path")
        .in("status", ["sent", "viewed", "finalized"])
        .not("driver_id", "is", null)
        .order("created_at", { ascending: true });

      if (error) throw error;

      const results = [];
      for (const row of invoices || []) {
        const { data: inbox } = await supabaseAdmin
          .from("driver_inbox_messages")
          .select("id")
          .eq("driver_id", row.driver_id)
          .contains("metadata", { invoice_id: row.id })
          .maybeSingle();

        if (inbox?.id && row.pdf_storage_path) {
          results.push({ invoice_id: row.id, status: "skipped" });
          continue;
        }

        const result = await deliverDriverStatement(supabaseAdmin, row.id, {
          regeneratePdf: !row.pdf_storage_path || regenerate_pdf,
          sentByUserId,
        });
        results.push({ invoice_id: row.id, ...result });
      }

      return new Response(JSON.stringify({ success: true, results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const ids: string[] = invoice_ids?.length
      ? invoice_ids
      : invoice_id
      ? [invoice_id]
      : [];

    if (ids.length === 0) {
      return new Response(JSON.stringify({ error: "invoice_id or invoice_ids required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results = [];
    for (const id of ids) {
      const result = await deliverDriverStatement(supabaseAdmin, id, {
        regeneratePdf: regenerate_pdf,
        sentByUserId,
      });
      results.push(result);
    }

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[deliver-driver-statement] Error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
