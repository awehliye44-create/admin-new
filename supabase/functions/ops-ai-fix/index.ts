import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const ALLOWED_FUNCTIONS: Record<string, { rpcName: string; riskLevel: string; paramKey: string }> = {
  repair_missing_commission:     { rpcName: "ops_repair_missing_commission",     riskLevel: "MEDIUM", paramKey: "p_trip_id" },
  repair_missing_driver_earning: { rpcName: "ops_repair_missing_driver_earning", riskLevel: "MEDIUM", paramKey: "p_trip_id" },
  repair_missing_financials:     { rpcName: "ops_repair_missing_financials",     riskLevel: "MEDIUM", paramKey: "p_trip_id" },
  retry_failed_dispatch:         { rpcName: "ops_retry_failed_dispatch",         riskLevel: "MEDIUM", paramKey: "p_trip_id" },
  resolve_alert_if_cleared:      { rpcName: "ops_resolve_alert_if_cleared",      riskLevel: "LOW",    paramKey: "p_alert_id" },
  replay_webhook:                { rpcName: "ops_replay_webhook",                riskLevel: "MEDIUM", paramKey: "p_event_id" },
  retry_failed_payout:           { rpcName: "ops_retry_failed_payout",           riskLevel: "HIGH",   paramKey: "p_payout_id" },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    // ─── AUTH: require admin JWT ──────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ error: "Unauthorized" }, 401);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
      return json({ error: "Unauthorized" }, 401);
    }
    const authedUserId = userData.user.id;

    // Verify admin role via user_roles table (NOT profiles — prevents privilege escalation)
    const { data: roleRow } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", authedUserId)
      .eq("role", "admin")
      .maybeSingle();
    if (!roleRow) {
      return json({ error: "Admin access required" }, 403);
    }

    const body = await req.json();
    const { action, alert_id } = body;
    if (!alert_id) return json({ error: "alert_id required" }, 400);

    // ─── ACTION: analyze ───────────────────────────────────────────
    if (action === "analyze") {
      const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
      if (!LOVABLE_API_KEY) return json({ error: "LOVABLE_API_KEY not configured" }, 500);

      const { data: alert, error: alertErr } = await supabase
        .from("ops_alerts").select("*").eq("id", alert_id).single();
      if (alertErr || !alert) return json({ error: "Alert not found" }, 404);

      const contextParts: string[] = [];

      if (alert.related_trip_id) {
        const { data: trip } = await supabase.from("trips")
          .select("id, status, final_fare_pence, payment_method, driver_id, service_area_id")
          .eq("id", alert.related_trip_id).single();
        if (trip) contextParts.push(`Trip: ${JSON.stringify(trip)}`);

        // trip_finance is DEPRECATED — wallet ledger is checked below

        const { data: ledger } = await supabase.from("driver_wallet_ledger")
          .select("type, amount_pence").eq("related_trip_id", alert.related_trip_id);
        contextParts.push(`Driver wallet ledger entries: ${ledger?.length ? JSON.stringify(ledger) : "NONE"}`);
      }

      if (alert.related_driver_id) {
        const { data: driver } = await supabase.from("drivers")
          .select("id, first_name, last_name, approval_status, commission_tier")
          .eq("id", alert.related_driver_id).single();
        if (driver) contextParts.push(`Driver: ${JSON.stringify(driver)}`);
      }

      const systemPrompt = `You are an Ops AI Fix Advisor for ONECAB, a ride-hailing platform.
Given an operational alert with its context, you must:
1. Identify what's wrong
2. Choose the BEST repair function from this list: ${Object.keys(ALLOWED_FUNCTIONS).join(", ")}
3. Determine the correct parameter value (a UUID) from the alert context
4. Assess risk level
5. Describe what the fix will do

RULES:
- You can ONLY suggest functions from the allowed list
- You must identify the correct entity ID from the context
- If no suitable function exists, set function_name to "none"
- Be specific about what will change`;

      const userPrompt = `Alert:
Category: ${alert.category}
Severity: ${alert.severity}
Title: ${alert.title}
Description: ${alert.description || "N/A"}
Metadata: ${JSON.stringify(alert.metadata || {})}
Related Trip: ${alert.related_trip_id || "none"}
Related Driver: ${alert.related_driver_id || "none"}
Related Payment: ${alert.related_payment_id || "none"}
Related Payout: ${alert.related_payout_batch_id || "none"}

Context:
${contextParts.join("\n")}`;

      const aiPayload = {
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        tools: [{
          type: "function",
          function: {
            name: "propose_fix",
            description: "Propose a fix for the ops alert",
            parameters: {
              type: "object",
              properties: {
                explanation: { type: "string", description: "Clear explanation of the issue and what the fix does" },
                root_cause: { type: "string", description: "Why this happened" },
                function_name: { type: "string", enum: [...Object.keys(ALLOWED_FUNCTIONS), "none"] },
                param_value: { type: "string", description: "The UUID parameter to pass to the function" },
                risk_level: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
                affected_entities: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { type: { type: "string" }, id: { type: "string" }, description: { type: "string" } },
                    required: ["type", "id"],
                  },
                },
                estimated_impact: { type: "string", description: "What will change when the fix runs" },
              },
              required: ["explanation", "root_cause", "function_name", "risk_level", "affected_entities", "estimated_impact"],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "propose_fix" } },
      };

      // Retry up to 3 times for transient gateway errors
      let aiResponse: Response | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${LOVABLE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(aiPayload),
        });
        if (aiResponse.status < 500) break;
        console.warn(`AI Gateway attempt ${attempt + 1} failed with ${aiResponse.status}, retrying...`);
        await aiResponse.text(); // consume body
        if (attempt < 2) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }

      if (!aiResponse!.ok) {
        if (aiResponse!.status === 429) return json({ error: "Rate limited. Try again shortly." }, 429);
        if (aiResponse!.status === 402) return json({ error: "AI credits exhausted." }, 402);
        if (aiResponse!.status >= 500) return json({ error: "AI Gateway temporarily unavailable. Please retry in a moment." }, 503);
        const errText = await aiResponse!.text();
        return json({ error: "AI analysis failed", detail: errText }, 500);
      }

      const aiResult = await aiResponse!.json();
      const toolCall = aiResult.choices?.[0]?.message?.tool_calls?.[0];
      let proposal: any;

      if (toolCall?.function?.arguments) {
        proposal = JSON.parse(toolCall.function.arguments);
      } else {
        proposal = {
          explanation: "AI could not determine a fix. Review the alert manually.",
          root_cause: "Unknown",
          function_name: "none",
          risk_level: "LOW",
          affected_entities: [],
          estimated_impact: "No automated fix available",
        };
      }

      // Override risk level from our own rules
      if (proposal.function_name && ALLOWED_FUNCTIONS[proposal.function_name]) {
        proposal.risk_level = ALLOWED_FUNCTIONS[proposal.function_name].riskLevel;
      }

      // Validate param_value is a real UUID — reject hallucinated placeholders
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (proposal.function_name !== "none" && proposal.param_value && !UUID_RE.test(proposal.param_value)) {
        console.warn("AI proposed invalid param_value:", proposal.param_value);
        proposal.function_name = "none";
        proposal.estimated_impact = "No automated fix available — the alert lacks a specific entity ID for repair.";
        proposal.explanation += " (Note: No valid target entity could be identified from this alert's metadata.)";
      }

      return json({ success: true, proposal });
    }

    // ─── ACTION: execute ──────────────────────────────────────────
    if (action === "execute") {
      const { function_name, param_value, explanation, risk_level, preview_data } = body;

      if (!function_name || !param_value || !user_id) {
        return json({ error: "function_name, param_value, and user_id required" }, 400);
      }

      // Validate param_value is a real UUID
      const EXEC_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!EXEC_UUID_RE.test(param_value)) {
        return json({ error: "Invalid parameter: not a valid UUID. This fix cannot be applied to this alert." }, 400);
      }

      const fnDef = ALLOWED_FUNCTIONS[function_name];
      if (!fnDef) return json({ error: `Function '${function_name}' is not allowed` }, 403);

      // Create audit record (pending)
      const { data: auditRow, error: auditErr } = await supabase
        .from("ops_fix_actions")
        .insert({
          alert_id,
          action_type: function_name,
          function_name: fnDef.rpcName,
          input_payload: { [fnDef.paramKey]: param_value },
          risk_level: fnDef.riskLevel,
          ai_explanation: explanation,
          preview_data: preview_data || null,
          executed_by: user_id,
          status: "pending",
        })
        .select("id")
        .single();

      if (auditErr) {
        console.error("Audit insert error:", auditErr);
        return json({ error: "Failed to create audit record" }, 500);
      }

      // Execute the safe RPC
      const { data: result, error: rpcErr } = await supabase.rpc(fnDef.rpcName, {
        [fnDef.paramKey]: param_value,
      });

      const finalStatus = rpcErr ? "failed" : "success";
      const finalResult = rpcErr ? { error: rpcErr.message } : result;

      await supabase.from("ops_fix_actions")
        .update({ status: finalStatus, result: finalResult })
        .eq("id", auditRow.id);

      return json({ success: !rpcErr, audit_id: auditRow.id, result: finalResult, status: finalStatus });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (e: any) {
    console.error("ops-ai-fix error:", e);
    return json({ error: e.message || "Unknown error" }, 500);
  }
});
