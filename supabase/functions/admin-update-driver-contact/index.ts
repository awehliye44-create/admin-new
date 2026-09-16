// Admin update driver contact — sync drivers row + linked auth.users email/phone.
// Body: { driver_id, first_name, last_name, email, phone, region_id }
//
// Auth: caller must be an authenticated admin (verified via user_roles).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface UpdateBody {
  driver_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  region_id: string;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizePhoneForAuth(phone: string): string {
  return phone.replace(/\s+/g, '').replace(/^\+/, '');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: 'Server misconfiguration' }, 500);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return jsonResponse({ error: 'Missing Authorization header' }, 401);
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const {
    data: { user: caller },
    error: callerErr,
  } = await userClient.auth.getUser();

  if (callerErr || !caller) {
    return jsonResponse({ error: 'Invalid session' }, 401);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: roleRow, error: roleErr } = await admin
    .from('user_roles')
    .select('role')
    .eq('user_id', caller.id)
    .eq('role', 'admin')
    .maybeSingle();

  if (roleErr) {
    return jsonResponse({ error: 'Role lookup failed' }, 500);
  }
  if (!roleRow) {
    return jsonResponse({ error: 'Forbidden: admin role required' }, 403);
  }

  let body: UpdateBody;
  try {
    body = (await req.json()) as UpdateBody;
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const { driver_id, first_name, last_name, email, phone, region_id } = body || {};
  if (!driver_id || !first_name || !last_name || !email || !phone || !region_id) {
    return jsonResponse({ error: 'driver_id, first_name, last_name, email, phone, region_id are required' }, 400);
  }

  const emailNorm = normalizeEmail(email);
  const phoneNorm = phone.trim();
  const phoneAuth = normalizePhoneForAuth(phoneNorm);

  const { data: existing, error: existingErr } = await admin
    .from('drivers')
    .select('id, user_id, email, phone')
    .eq('id', driver_id)
    .maybeSingle();

  if (existingErr) {
    return jsonResponse({ error: `Failed to load driver: ${existingErr.message}` }, 500);
  }
  if (!existing) {
    return jsonResponse({ error: 'Driver not found' }, 404);
  }

  const { error: updateErr } = await admin
    .from('drivers')
    .update({
      first_name,
      last_name,
      email: emailNorm,
      phone: phoneNorm,
      region_id,
    })
    .eq('id', driver_id);

  if (updateErr) {
    return jsonResponse({ error: `Failed to update driver: ${updateErr.message}` }, 500);
  }

  const userId = existing.user_id as string | null;
  let auth_synced = false;
  let auth_sync_skipped_reason: string | null = null;

  if (!userId) {
    auth_sync_skipped_reason = 'no_user_id';
  } else {
    const { data: authUser, error: authLookupErr } = await admin.auth.admin.getUserById(userId);

    if (authLookupErr || !authUser?.user) {
      auth_sync_skipped_reason = 'auth_user_not_found';
    } else {
      const authUpdate: {
        email?: string;
        email_confirm?: boolean;
        phone?: string;
        phone_confirm?: boolean;
      } = {};

      if (normalizeEmail(existing.email ?? '') !== emailNorm) {
        authUpdate.email = emailNorm;
        authUpdate.email_confirm = true;
      }

      const existingPhoneAuth = normalizePhoneForAuth(existing.phone ?? '');
      if (existingPhoneAuth !== phoneAuth) {
        authUpdate.phone = phoneAuth;
        authUpdate.phone_confirm = true;
      }

      if (Object.keys(authUpdate).length > 0) {
        const { error: authUpdateErr } = await admin.auth.admin.updateUserById(userId, authUpdate);
        if (authUpdateErr) {
          return jsonResponse(
            {
              error: `Driver row updated, but auth sync failed: ${authUpdateErr.message}`,
              driver_updated: true,
              auth_synced: false,
            },
            500,
          );
        }
        auth_synced = true;
      } else {
        auth_sync_skipped_reason = 'no_auth_changes';
      }

      await admin
        .from('profiles')
        .update({ phone: phoneNorm })
        .eq('user_id', userId);
    }
  }

  await admin.from('audit_logs').insert({
    event_type: 'driver_contact_updated',
    user_id: userId,
    details: {
      driver_id,
      email: emailNorm,
      phone: phoneNorm,
      auth_synced,
      auth_sync_skipped_reason,
      updated_by: caller.id,
    },
  });

  return jsonResponse({
    success: true,
    driver_id,
    auth_synced,
    auth_sync_skipped_reason,
  });
});
