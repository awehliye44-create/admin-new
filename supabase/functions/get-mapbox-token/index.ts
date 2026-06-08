import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Returns the appropriate Mapbox public token (pk.*) for the requesting client.
 *
 * MAPBOX_WEB_TOKEN     → browser (Lovable preview, adminonecab.net)
 * MAPBOX_PUBLIC_TOKEN  → iOS + Android native (fallback only for web if web unset)
 */

type Platform = "web" | "ios" | "android";

function pickToken(platform: Platform): { token: string | null; source: string } {
  const web = Deno.env.get("MAPBOX_WEB_TOKEN") || null;
  const native = Deno.env.get("MAPBOX_PUBLIC_TOKEN") || null;

  if (platform === "ios" || platform === "android") {
    if (native) return { token: native, source: "MAPBOX_PUBLIC_TOKEN" };
    if (web) return { token: web, source: "MAPBOX_WEB_TOKEN (fallback)" };
    return { token: null, source: "" };
  }
  if (web) return { token: web, source: "MAPBOX_WEB_TOKEN" };
  if (native) return { token: native, source: "MAPBOX_PUBLIC_TOKEN (fallback)" };
  return { token: null, source: "" };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let platform: Platform = "web";
    if (req.method === "POST") {
      try {
        const body = await req.json();
        const p = String(body?.platform || "").toLowerCase();
        if (p === "ios" || p === "android" || p === "web") platform = p;
      } catch {
        /* default to web */
      }
    }

    const { token, source } = pickToken(platform);

    if (!token) {
      console.error(
        `[get-mapbox-token] No token available for platform=${platform}. ` +
          `Set MAPBOX_WEB_TOKEN (web) and MAPBOX_PUBLIC_TOKEN (native).`,
      );
      return new Response(
        JSON.stringify({
          error: "Mapbox token not configured",
          platform,
          expected: platform === "web" ? "MAPBOX_WEB_TOKEN" : "MAPBOX_PUBLIC_TOKEN",
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log(`[get-mapbox-token] platform=${platform} source=${source}`);
    return new Response(JSON.stringify({ token, platform }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
