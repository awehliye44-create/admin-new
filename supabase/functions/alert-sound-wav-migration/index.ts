import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-migration-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const token = req.headers.get("x-migration-token") ?? "";
  const expected = Deno.env.get("ALERT_SOUND_MIGRATION_TOKEN") ?? "";
  if (!expected || token !== expected) {
    return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const body = await req.json();
  const { path } = body;

  if (body.op === "purge_mp3") {
    const purge = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: files } = await purge.storage.from("alert-sounds").list("", { limit: 1000 });
    const mp3s = (files ?? []).filter((f) => f.name.toLowerCase().endsWith(".mp3")).map((f) => f.name);
    const removed = mp3s.length ? await purge.storage.from("alert-sounds").remove(mp3s) : { error: null };
    return new Response(JSON.stringify({ removed: mp3s, error: removed.error?.message ?? null }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (typeof path !== "string" || !path.endsWith(".wav")) {
    return new Response(JSON.stringify({ error: "INVALID_PATH" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  await supabase.storage.updateBucket("alert-sounds", {
    public: true,
    allowedMimeTypes: ["audio/wav", "audio/x-wav", "audio/wave"],
  });

  const { data, error } = await supabase.storage
    .from("alert-sounds")
    .createSignedUploadUrl(path, { upsert: true });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
