import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { z } from 'npm:zod@3.23.8';

const CATEGORIES = ['food', 'grocery', 'retail', 'pharmacy', 'parcel'] as const;

const BodySchema = z.object({
  business_name: z.string().trim().min(2).max(120),
  merchant_type: z.enum(CATEGORIES),
  owner_name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().min(5).max(40),
  address: z.string().trim().min(3).max(300),
  postcode: z.string().trim().min(2).max(20),
  service_area_id: z.string().uuid(),
  business_description: z.string().trim().min(5).max(2000),
  city: z.string().trim().max(120).optional(),
  opening_hours: z.record(z.any()).optional(),
  delivery_radius_km: z.number().min(0).max(100).optional(),
  prep_time_minutes: z.number().int().min(0).max(600).optional(),
  // Base64 data URLs for optional uploads
  logo_base64: z.string().max(8_000_000).optional(),
  logo_mime: z.string().max(80).optional(),
  banner_base64: z.string().max(12_000_000).optional(),
  banner_mime: z.string().max(80).optional(),
});

const sanitize = (s: string) =>
  s.replace(/[\u0000-\u001F\u007F]/g, '').replace(/<[^>]*>/g, '').trim();

function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.includes(',') ? b64.split(',')[1] : b64;
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let json: unknown;
  try { json = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const p = parsed.data;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // Validate service area exists
  const { data: sa, error: saErr } = await supabase
    .from('service_areas').select('id').eq('id', p.service_area_id).maybeSingle();
  if (saErr || !sa) {
    return new Response(JSON.stringify({ error: 'Invalid service_area_id' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Duplicate check
  const { data: dup } = await supabase
    .from('merchants')
    .select('id')
    .or(`email.ilike.${p.email},business_name.ilike.${p.business_name}`)
    .limit(1)
    .maybeSingle();
  if (dup) {
    return new Response(JSON.stringify({ error: 'An application with this email or business name already exists.' }), {
      status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Insert merchant first to get id, then upload media
  const insertPayload: Record<string, unknown> = {
    business_name: sanitize(p.business_name),
    category: p.merchant_type,
    owner_name: sanitize(p.owner_name),
    email: p.email.toLowerCase(),
    phone: sanitize(p.phone),
    address: sanitize(p.address),
    city: p.city ? sanitize(p.city) : null,
    postcode: sanitize(p.postcode),
    service_area_id: p.service_area_id,
    description: sanitize(p.business_description),
    opening_hours: p.opening_hours ?? {},
    status: 'pending',
  };
  if (p.delivery_radius_km != null) insertPayload.delivery_radius_km = p.delivery_radius_km;
  if (p.prep_time_minutes != null) insertPayload.prep_time_minutes = p.prep_time_minutes;

  const { data: merchant, error: insErr } = await supabase
    .from('merchants').insert(insertPayload).select('id').single();
  if (insErr || !merchant) {
    const code = insErr?.code === '23505' ? 409 : 500;
    return new Response(JSON.stringify({ error: insErr?.message ?? 'Failed to create application' }), {
      status: code, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const updates: Record<string, string> = {};
  try {
    if (p.logo_base64) {
      const bytes = b64ToBytes(p.logo_base64);
      const path = `${merchant.id}/logo-${Date.now()}`;
      const { error } = await supabase.storage.from('merchant-logos')
        .upload(path, bytes, { contentType: p.logo_mime ?? 'image/png', upsert: true });
      if (!error) {
        const { data } = supabase.storage.from('merchant-logos').getPublicUrl(path);
        updates.logo_url = data.publicUrl;
      }
    }
    if (p.banner_base64) {
      const bytes = b64ToBytes(p.banner_base64);
      const path = `${merchant.id}/banner-${Date.now()}`;
      const { error } = await supabase.storage.from('merchant-banners')
        .upload(path, bytes, { contentType: p.banner_mime ?? 'image/png', upsert: true });
      if (!error) {
        const { data } = supabase.storage.from('merchant-banners').getPublicUrl(path);
        updates.banner_url = data.publicUrl;
      }
    }
    if (Object.keys(updates).length) {
      await supabase.from('merchants').update(updates).eq('id', merchant.id);
    }
  } catch (e) {
    console.error('Upload error', e);
  }

  return new Response(JSON.stringify({ success: true, application_id: merchant.id, status: 'pending' }), {
    status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
