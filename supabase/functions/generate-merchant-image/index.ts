import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      return new Response(JSON.stringify({ error: 'LOVABLE_API_KEY not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const authHeader = req.headers.get('Authorization') ?? '';
    const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: corsHeaders });

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: roleRow } = await admin.from('user_roles').select('role').eq('user_id', user.id).eq('role', 'admin').maybeSingle();
    if (!roleRow) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: corsHeaders });

    const { merchant_id, product_id, prompt } = await req.json();
    if (!merchant_id || !prompt) {
      return new Response(JSON.stringify({ error: 'merchant_id and prompt required' }), { status: 400, headers: corsHeaders });
    }

    // Check credits
    const { data: credits } = await admin.from('merchant_ai_credits').select('credits_remaining').eq('merchant_id', merchant_id).maybeSingle();
    const remaining = credits?.credits_remaining ?? 0;
    if (remaining < 1) {
      return new Response(JSON.stringify({ error: 'no_credits', message: 'No AI credits remaining' }), { status: 402, headers: corsHeaders });
    }

    // Insert pending history row
    const { data: gen, error: genErr } = await admin.from('merchant_ai_generations').insert({
      merchant_id, product_id: product_id ?? null, prompt, status: 'pending', created_by: user.id,
    }).select().single();
    if (genErr) throw genErr;

    // Call Lovable AI image generation (non-streaming for simplicity)
    const aiRes = await fetch('https://ai.gateway.lovable.dev/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-image-2',
        prompt,
        quality: 'low',
        size: '1024x1024',
        n: 1,
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      await admin.from('merchant_ai_generations').update({ status: 'failed' }).eq('id', gen.id);
      return new Response(JSON.stringify({ error: 'ai_failed', detail: errText }), { status: aiRes.status, headers: corsHeaders });
    }

    const aiData = await aiRes.json();
    const b64 = aiData?.data?.[0]?.b64_json;
    if (!b64) {
      await admin.from('merchant_ai_generations').update({ status: 'failed' }).eq('id', gen.id);
      return new Response(JSON.stringify({ error: 'no_image_data' }), { status: 500, headers: corsHeaders });
    }

    // Upload to storage
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const path = `${merchant_id}/${gen.id}.png`;
    const { error: upErr } = await admin.storage.from('merchant-products').upload(path, bytes, {
      contentType: 'image/png', upsert: true,
    });
    if (upErr) {
      await admin.from('merchant_ai_generations').update({ status: 'failed' }).eq('id', gen.id);
      throw upErr;
    }
    const { data: pub } = admin.storage.from('merchant-products').getPublicUrl(path);
    const imageUrl = pub.publicUrl;

    await admin.from('merchant_ai_generations').update({ status: 'completed', image_url: imageUrl }).eq('id', gen.id);
    await admin.from('merchant_ai_credits').update({
      credits_remaining: remaining - 1, updated_at: new Date().toISOString(),
    }).eq('merchant_id', merchant_id);

    if (product_id) {
      await admin.from('merchant_products').update({
        image_url: imageUrl, image_source: 'ai_generated', image_approved: false,
      }).eq('id', product_id);
    }

    return new Response(JSON.stringify({ ok: true, image_url: imageUrl, generation_id: gen.id, credits_remaining: remaining - 1 }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('generate-merchant-image error', e);
    return new Response(JSON.stringify({ error: 'internal', message: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
