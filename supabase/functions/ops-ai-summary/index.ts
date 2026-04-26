import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { alert_id } = await req.json();
    if (!alert_id) {
      return new Response(JSON.stringify({ error: "alert_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      return new Response(
        JSON.stringify({ error: "LOVABLE_API_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Fetch alert
    const { data: alert, error: alertErr } = await supabase
      .from("ops_alerts")
      .select("*")
      .eq("id", alert_id)
      .single();
    if (alertErr || !alert) {
      return new Response(JSON.stringify({ error: "Alert not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch related logs for context
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

    const systemPrompt = `You are an Ops Intelligence AI for a ride-hailing platform called ONECAB. You analyze operational alerts and provide actionable summaries.

Given an alert with its context (category, severity, metadata, related logs), return a JSON object with exactly these fields:
- summary: A clear 2-3 sentence summary of what happened
- root_cause: The most likely root cause based on the evidence
- recommended_action: Specific steps the ops team should take to resolve this

Be specific and actionable. Reference actual data from the metadata and logs when available.`;

    const userPrompt = `Analyze this ops alert:

Category: ${alert.category}
Severity: ${alert.severity}
Title: ${alert.title}
Description: ${alert.description || "N/A"}
Fingerprint: ${alert.fingerprint}
Occurrence count: ${alert.fingerprint_count}
Source: ${alert.source}
App: ${alert.app || "N/A"}
Metadata: ${JSON.stringify(alert.metadata || {})}
${alert.related_trip_id ? `Related Trip: ${alert.related_trip_id}` : ""}
${alert.related_driver_id ? `Related Driver: ${alert.related_driver_id}` : ""}
${alert.related_payment_id ? `Related Payment: ${alert.related_payment_id}` : ""}

Related error logs (last 10):
${logs && logs.length > 0 ? logs.map((l: any) => `[${l.level}] ${l.source}: ${l.message}`).join("\n") : "No related logs found."}`;

    // Call Lovable AI Gateway with tool calling for structured output (retry on 5xx)
    const aiPayload = {
      model: "google/gemini-3-flash-preview",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "ops_alert_analysis",
            description:
              "Provide structured analysis of an ops alert with summary, root cause, and recommended action.",
            parameters: {
              type: "object",
              properties: {
                summary: { type: "string", description: "Clear 2-3 sentence summary of what happened" },
                root_cause: { type: "string", description: "Most likely root cause based on evidence" },
                recommended_action: { type: "string", description: "Specific steps to resolve" },
              },
              required: ["summary", "root_cause", "recommended_action"],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "ops_alert_analysis" } },
    };

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
      await aiResponse.text();
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }

    if (!aiResponse!.ok) {
      const errText = await aiResponse!.text();
      console.error("AI Gateway error:", aiResponse!.status, errText);

      if (aiResponse!.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limited. Please try again shortly." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (aiResponse!.status === 402) {
        return new Response(
          JSON.stringify({ error: "AI credits exhausted. Add funds in workspace settings." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (aiResponse!.status >= 500) {
        return new Response(
          JSON.stringify({ error: "AI Gateway temporarily unavailable. Please retry in a moment." }),
          { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({ error: "AI analysis failed", detail: errText }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const aiResult = await aiResponse!.json();
    const toolCall = aiResult.choices?.[0]?.message?.tool_calls?.[0];

    let analysis: { summary: string; root_cause: string; recommended_action: string };

    if (toolCall?.function?.arguments) {
      analysis = JSON.parse(toolCall.function.arguments);
    } else {
      // Fallback: try to parse from content
      const content = aiResult.choices?.[0]?.message?.content || "";
      try {
        analysis = JSON.parse(content);
      } catch {
        analysis = {
          summary: content || "AI analysis could not be parsed.",
          root_cause: "Unable to determine — AI response format unexpected.",
          recommended_action: "Review the alert manually and check related logs.",
        };
      }
    }

    // Delete existing summaries for this alert, then insert new one
    await supabase
      .from("ops_alert_summaries")
      .delete()
      .eq("alert_id", alert_id);

    const { error: insertErr } = await supabase
      .from("ops_alert_summaries")
      .insert({
        alert_id,
        summary: analysis.summary,
        root_cause: analysis.root_cause,
        recommended_action: analysis.recommended_action,
        confidence_score: 0.85,
        model_used: "google/gemini-3-flash-preview",
      });

    if (insertErr) throw insertErr;

    return new Response(
      JSON.stringify({ success: true, analysis }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("ops-ai-summary error:", e);
    return new Response(
      JSON.stringify({ error: (e as Error).message || "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
