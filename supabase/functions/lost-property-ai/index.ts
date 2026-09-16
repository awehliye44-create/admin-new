import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // Authenticate admin
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify admin
    const { data: profile } = await sb
      .from("profiles")
      .select("role")
      .eq("user_id", user.id)
      .single();
    if (!profile || profile.role !== "admin") {
      return new Response(JSON.stringify({ error: "Admin only" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const url = new URL(req.url);
    const type = url.searchParams.get("type") || "summary";
    const { case_id } = await req.json();

    if (!case_id) {
      return new Response(JSON.stringify({ error: "case_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch case + messages
    const { data: lpCase } = await sb
      .from("lost_property_cases")
      .select("*")
      .eq("id", case_id)
      .single();

    if (!lpCase) {
      return new Response(JSON.stringify({ error: "Case not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: messages } = await sb
      .from("lost_property_messages")
      .select("*")
      .eq("case_id", case_id)
      .order("created_at", { ascending: true })
      .limit(50);

    const chatHistory = (messages || [])
      .map((m: any) => `[${m.sender_type}] ${m.message}`)
      .join("\n");

    const caseContext = `
Case: ${lpCase.case_number}
Status: ${lpCase.status}
Item: ${lpCase.item_category} - ${lpCase.item_description}
Customer confirmed: ${lpCase.customer_confirmed ?? "pending"}
Return method: ${lpCase.return_method ?? "not selected"}
Chat enabled: ${lpCase.chat_enabled}
Created: ${lpCase.created_at}

Chat messages:
${chatHistory || "(no messages)"}
    `.trim();

    let systemPrompt: string;
    switch (type) {
      case "summary":
        systemPrompt = `You are a support agent assistant. Provide a brief, actionable summary of this lost property case. Include: current state, key events, and recommended next steps. Keep it under 150 words.`;
        break;
      case "reply":
        systemPrompt = `You are a support agent assistant. Based on the case context, suggest a professional, empathetic reply message the admin could send. Keep it concise and helpful. Do NOT include any greeting like "Dear customer" - just the message body.`;
        break;
      case "priority":
        systemPrompt = `You are a support agent assistant. Assess the priority of this lost property case. Consider: item value (phones > keys > bags > other), time elapsed, escalation status, customer sentiment. Respond with: PRIORITY: [HIGH/MEDIUM/LOW] followed by a brief justification (2-3 sentences).`;
        break;
      default:
        systemPrompt = `You are a helpful support assistant. Analyze this lost property case and provide useful insights.`;
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      return new Response(JSON.stringify({ error: "AI not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: caseContext },
        ],
      }),
    });

    if (!aiResp.ok) {
      const errText = await aiResp.text();
      console.error("AI gateway error:", aiResp.status, errText);

      if (aiResp.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again shortly." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResp.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted. Please top up." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: "AI service unavailable" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiData = await aiResp.json();
    const result = aiData.choices?.[0]?.message?.content || "No response from AI";

    return new Response(JSON.stringify({ success: true, result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("lost-property-ai error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
