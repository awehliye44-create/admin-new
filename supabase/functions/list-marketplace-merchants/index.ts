// Public endpoint: returns merchants visible to a customer for a given service area.
// Enforces the marketplace visibility rules in ONE place so native + web apps stay in sync.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

type Category = 'food' | 'grocery' | 'retail' | 'pharmacy' | 'parcel';
const CATEGORIES: Category[] = ['food', 'grocery', 'retail', 'pharmacy', 'parcel'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    let serviceAreaId = url.searchParams.get('service_area_id');
    let category = url.searchParams.get('category') as Category | null;

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      serviceAreaId = serviceAreaId ?? body.service_area_id ?? null;
      category = category ?? body.category ?? null;
    }

    if (!serviceAreaId) {
      return new Response(
        JSON.stringify({ error: 'service_area_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    if (category && !CATEGORIES.includes(category)) {
      return new Response(
        JSON.stringify({ error: 'invalid category' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // 1. Global category flags
    const { data: globalCats } = await supabase
      .from('merchant_categories')
      .select('category, enabled, display_name');
    const globallyEnabled = new Set(
      (globalCats ?? []).filter((c: any) => c.enabled).map((c: any) => c.category),
    );

    // 2. Per-service-area flags
    const { data: saSettings } = await supabase
      .from('service_area_merchant_settings')
      .select('category, enabled, delivery_enabled')
      .eq('service_area_id', serviceAreaId);

    const deliveryOn = (saSettings ?? []).some((s: any) => s.delivery_enabled);
    const saEnabled = new Set(
      (saSettings ?? []).filter((s: any) => s.enabled).map((s: any) => s.category),
    );

    // If delivery master is off for this SA, nothing is visible
    if (!deliveryOn) {
      return new Response(
        JSON.stringify({
          delivery_enabled: false,
          available_categories: [],
          merchants: [],
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const availableCategories = CATEGORIES.filter(
      (c) => globallyEnabled.has(c) && saEnabled.has(c),
    );

    // 3. Approved merchants in this SA, filtered to enabled categories
    let q = supabase
      .from('merchants')
      .select(
        'id, business_name, category, description, logo_url, banner_url, is_open, prep_time_minutes, delivery_radius_km, min_order_amount, address, city, postcode',
      )
      .eq('service_area_id', serviceAreaId)
      .eq('status', 'approved')
      .in('category', availableCategories.length ? availableCategories : ['__none__']);

    if (category) {
      if (!availableCategories.includes(category)) {
        return new Response(
          JSON.stringify({
            delivery_enabled: true,
            available_categories: availableCategories,
            merchants: [],
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      q = q.eq('category', category);
    }

    const { data: merchants, error } = await q.order('business_name');
    if (error) throw error;

    return new Response(
      JSON.stringify({
        delivery_enabled: true,
        available_categories: availableCategories,
        merchants: merchants ?? [],
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ error: e?.message ?? 'internal_error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
