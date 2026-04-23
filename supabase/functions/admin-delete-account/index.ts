// Admin delete account — hard delete a role profile (driver or customer).
// If the user has no remaining role profiles after the delete, also delete
// the underlying Supabase Auth user so they cannot sign in again.
//
// Body: { target: 'driver' | 'customer', profile_id: string, reason?: string }
//
// Auth: caller must be an authenticated admin (verified via user_roles).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type DeleteTarget = 'driver' | 'customer';

interface DeleteBody {
  target: DeleteTarget;
  profile_id: string;
  reason?: string;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
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

  // 1. Identify caller
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

  // 2. Verify caller is admin
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

  // 3. Parse + validate body
  let body: DeleteBody;
  try {
    body = (await req.json()) as DeleteBody;
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const { target, profile_id, reason } = body || {};
  if (!target || (target !== 'driver' && target !== 'customer')) {
    return jsonResponse({ error: 'target must be "driver" or "customer"' }, 400);
  }
  if (!profile_id || typeof profile_id !== 'string') {
    return jsonResponse({ error: 'profile_id is required' }, 400);
  }

  // 4. Look up the profile to find its auth user_id
  const profileTable = target === 'driver' ? 'drivers' : 'customers';
  const { data: profile, error: profileErr } = await admin
    .from(profileTable)
    .select('id, user_id')
    .eq('id', profile_id)
    .maybeSingle();

  if (profileErr) {
    return jsonResponse({ error: `Failed to load ${target}: ${profileErr.message}` }, 500);
  }
  if (!profile) {
    return jsonResponse({ error: `${target} not found` }, 404);
  }

  const targetUserId = (profile as { user_id: string }).user_id;
  if (!targetUserId) {
    return jsonResponse({ error: `${target} has no linked auth user` }, 422);
  }

  // 5. Hard-delete the role profile row.
  // FK cascades on dependent tables (trips, wallets, ledger, etc.) are
  // handled by the existing ON DELETE behavior defined at schema level.
  const { error: delProfileErr } = await admin
    .from(profileTable)
    .delete()
    .eq('id', profile_id);

  if (delProfileErr) {
    return jsonResponse(
      { error: `Failed to delete ${target} profile: ${delProfileErr.message}` },
      500,
    );
  }

  // 6. Check for any remaining role profiles for this auth user
  const [{ count: remainingDrivers }, { count: remainingCustomers }] =
    await Promise.all([
      admin
        .from('drivers')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', targetUserId),
      admin
        .from('customers')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', targetUserId),
    ]);

  // Also preserve admin/staff users — never delete an auth user that has any role assignment
  const { count: remainingRoles } = await admin
    .from('user_roles')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', targetUserId);

  const hasOtherProfiles =
    (remainingDrivers ?? 0) > 0 ||
    (remainingCustomers ?? 0) > 0 ||
    (remainingRoles ?? 0) > 0;

  let authUserDeleted = false;

  if (!hasOtherProfiles) {
    const { error: delAuthErr } = await admin.auth.admin.deleteUser(targetUserId);
    if (delAuthErr) {
      // Profile is gone but auth deletion failed — surface the error so admin can retry.
      return jsonResponse(
        {
          error: `Profile deleted, but failed to remove auth user: ${delAuthErr.message}`,
          profile_deleted: true,
          auth_user_deleted: false,
        },
        500,
      );
    }
    authUserDeleted = true;
  }

  // 7. Audit log
  await admin.from('audit_logs').insert({
    event_type: `${target}_hard_deleted`,
    user_id: targetUserId,
    details: {
      profile_id,
      target,
      reason: reason ?? null,
      auth_user_deleted: authUserDeleted,
      remaining_drivers: remainingDrivers ?? 0,
      remaining_customers: remainingCustomers ?? 0,
      remaining_roles: remainingRoles ?? 0,
      deleted_by: caller.id,
    },
  });

  return jsonResponse({
    success: true,
    target,
    profile_id,
    auth_user_deleted: authUserDeleted,
    remaining_profiles: {
      drivers: remainingDrivers ?? 0,
      customers: remainingCustomers ?? 0,
    },
  });
});
