import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAdmin } from "../_shared/internalAuth.ts";
import { requestOpsAlertAiAnalysis } from "../_shared/opsAlertAnalysis.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;

  try {
    const { alert_id } = await req.json();
    if (!alert_id) {
      return json({ error: "alert_id required" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: alert, error: alertErr } = await supabase
      .from("ops_alerts")
      .select("*")
      .eq("id", alert_id)
      .single();
    if (alertErr || !alert) {
      return json({ error: "Alert not found" }, 404);
    }

    const alertTime = new Date(alert.last_detected_at);
    const from = new Date(alertTime.getTime() - 5 * 60 * 1000).toISOString();
    const to = new Date(alertTime.getTime() + 5 * 60 * 1000).toISOString();
    const { data: logs } = await supabase
      .from("ops_logs")
      .select("level, source, message")
      .gte("created_at", from)
      .lte("created_at", to)
      .in("level", ["error", "fatal", "warn"])
      .order("created_at", { ascending: false })
      .limit(10);

    const { analysis, modelUsed, degraded } = await requestOpsAlertAiAnalysis({
      apiKey: Deno.env.get("LOVABLE_API_KEY"),
      alert,
      logs,
    });

    await supabase.from("ops_alert_summaries").delete().eq("alert_id", alert_id);

    const { error: insertErr } = await supabase.from("ops_alert_summaries").insert({
      alert_id,
      summary: analysis.summary,
      root_cause: analysis.root_cause,
      recommended_action: analysis.recommended_action,
      confidence_score: degraded ? 0.55 : 0.85,
      model_used: modelUsed,
    });

    if (insertErr) throw insertErr;

    return json({
      success: true,
      degraded,
      analysis,
      ...(degraded
        ? {
          warning:
            "AI gateway unavailable or misconfigured — saved a rules-based summary instead. Update LOVABLE_API_KEY in Supabase secrets for full AI analysis.",
        }
        : {}),
    });
  } catch (e) {
    console.error("ops-ai-summary error:", e);
    return json({ error: (e as Error).message || "Unknown error" }, 500);
  }
});
