import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildHelpCentrePayload,
  isHelpAudience,
  type HelpArticleRow,
  type HelpCategoryRow,
} from "../_shared/helpCentreSSOT.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

/**
 * Read-only Help Centre feed for the Customer and Driver Expo apps.
 * Audience separation is enforced server-side: a customer request can never
 * return driver articles and vice-versa.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const audience = url.searchParams.get("audience");
    if (!isHelpAudience(audience)) {
      return json({ error: "audience query param must be 'customer' or 'driver'" }, 400);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "UNAUTHENTICATED" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "UNAUTHENTICATED" }, 401);

    // Driver audience additionally requires a driver profile.
    if (audience === "driver") {
      const { data: driver } = await admin
        .from("drivers")
        .select("id")
        .eq("user_id", userData.user.id)
        .maybeSingle();
      if (!driver) return json({ error: "DRIVER_PROFILE_REQUIRED" }, 403);
    }

    const [{ data: categories, error: catErr }, { data: articles, error: artErr }] = await Promise.all([
      admin
        .from("help_centre_categories")
        .select("id, audience, title, description, icon_key, display_order, is_active")
        .eq("audience", audience)
        .eq("is_active", true),
      admin
        .from("help_centre_articles")
        .select(
          "id, audience, category_id, title, slug, summary, body, cover_image_path, display_order, is_featured, status, is_active, published_at, updated_at",
        )
        .eq("audience", audience)
        .eq("status", "published")
        .eq("is_active", true),
    ]);

    if (catErr) throw catErr;
    if (artErr) throw artErr;

    const payload = buildHelpCentrePayload(
      audience,
      (categories ?? []) as HelpCategoryRow[],
      (articles ?? []) as HelpArticleRow[],
    );

    return json(payload);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
