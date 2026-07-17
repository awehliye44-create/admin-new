// Shared helper: verify caller JWT and ensure admin role for super-admin payment controls.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export interface GateResult {
  ok: true;
  supabase: SupabaseClient;
  userId: string;
}
export interface GateError {
  ok: false;
  response: Response;
}

export async function requireAdmin(req: Request): Promise<GateResult | GateError> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }),
    };
  }

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }),
    };
  }

  // Authoritative role check via user_roles (per project policy)
  const { data: roleRow, error: roleErr } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', user.id)
    .eq('role', 'admin')
    .maybeSingle();

  if (roleErr || !roleRow) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: 'Forbidden — admin role required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }),
    };
  }

  return { ok: true, supabase, userId: user.id };
}

/** Admin panel staff (staff_profiles) or legacy user_roles admin. */
export async function requireAdminOrStaff(req: Request): Promise<GateResult | GateError> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }),
    };
  }

  const token = authHeader.replace('Bearer ', '');
  if (token === supabaseServiceKey) {
    return { ok: true, supabase, userId: 'service-role' };
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }),
    };
  }

  const { data: roleRow } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', user.id)
    .eq('role', 'admin')
    .maybeSingle();

  if (roleRow) {
    return { ok: true, supabase, userId: user.id };
  }

  const { data: staffRow } = await supabase
    .from('staff_profiles')
    .select('id, is_active')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .maybeSingle();

  if (staffRow) {
    return { ok: true, supabase, userId: user.id };
  }

  return {
    ok: false,
    response: new Response(JSON.stringify({ success: false, error: 'Forbidden — admin or staff access required' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }),
  };
}

/**
 * After requireAdminOrStaff: enforce role_page_permissions for a page slug.
 * Mirrors frontend canAccessPage — staff role must have can_access=true.
 * Legacy user_roles.admin (no staff_profiles) is treated as super_admin page set.
 * Service-role callers pass through.
 */
export async function requirePageAccess(
  gate: GateResult,
  pageSlug: string,
): Promise<GateResult | GateError> {
  if (gate.userId === 'service-role') return gate;

  const { data: staffRow } = await gate.supabase
    .from('staff_profiles')
    .select('role, is_active')
    .eq('user_id', gate.userId)
    .eq('is_active', true)
    .maybeSingle();

  const role = staffRow?.role
    ? String(staffRow.role)
    : 'super_admin'; // backward compat: legacy admin JWT without staff profile

  const { data: perm, error: permErr } = await gate.supabase
    .from('role_page_permissions')
    .select('can_access')
    .eq('role', role)
    .eq('page_slug', pageSlug)
    .eq('can_access', true)
    .maybeSingle();

  if (permErr) {
    return {
      ok: false,
      response: new Response(JSON.stringify({
        success: false,
        error: 'Permission check failed',
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }),
    };
  }

  if (!perm) {
    return {
      ok: false,
      response: new Response(JSON.stringify({
        success: false,
        error: `Forbidden — missing page access (${pageSlug})`,
        code: 'PAGE_FORBIDDEN',
      }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }),
    };
  }

  return gate;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
