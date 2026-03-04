import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const app = url.searchParams.get("app");

    if (!app || !["customer", "driver", "corporate"].includes(app)) {
      return new Response(
        JSON.stringify({ error: "app query param must be customer, driver, or corporate" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Get latest published version for each slug in the requested scope + shared
    const { data, error } = await supabase
      .from("content_items")
      .select("app_scope, slug, title, content_html, version, published_at")
      .in("app_scope", [app, "shared"])
      .eq("status", "published")
      .order("version", { ascending: false });

    if (error) throw error;

    // Deduplicate: keep highest version per (app_scope, slug)
    const seen = new Set<string>();
    const result: Record<string, any> = {};
    for (const row of data || []) {
      const key = `${row.app_scope}:${row.slug}`;
      if (!seen.has(key)) {
        seen.add(key);
        result[row.slug] = {
          title: row.title,
          content: row.content_html,
          version: row.version,
          published_at: row.published_at,
        };
      }
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
