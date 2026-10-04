// Admin delete account — hard delete a role profile (driver or customer).
// If the user has no remaining role profiles after the delete, also delete
// the underlying Supabase Auth user so they cannot sign in again.
// Always signs the user out of every device and resolves the profile's pending
// account_deletion support request. Trip, payment, invoice and payout history
// is retained (see step 5).
//
// Body: { target: 'driver' | 'customer', profile_id: string, reason?: string }
//
// Auth: caller must be an authenticated admin (verified via user_roles).

import { createClient } from 'npm:@supabase/supabase-js@2.57.2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type DeleteTarget = 'driver' | 'customer';

/** Matches the pending-request unique indexes on support_conversations. */
const PENDING_DELETION_STATUSES = ['open', 'waiting'];

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

  // Read before step 5: deleting a customer SET NULLs support_conversations.customer_id.
  const profileColumn = target === 'driver' ? 'driver_id' : 'customer_id';
  const { data: pendingDeletionRows, error: pendingDeletionErr } = await admin
    .from('support_conversations')
    .select('id')
    .eq('category', 'account_deletion')
    .in('status', PENDING_DELETION_STATUSES)
    .eq(profileColumn, profile_id);
  if (pendingDeletionErr) {
    return jsonResponse(
      { error: `Failed to load deletion requests: ${pendingDeletionErr.message}` },
      500,
    );
  }
  const pendingDeletionIds = (pendingDeletionRows ?? []).map((row: { id: string }) => row.id);

  // 5. Remove the role profile.
  // Drivers: soft-delete + detach Auth. Commission wallet / payout / settlement
  // rows keep driver_id (NOT NULL) — hard-deleting the driver aborts Auth delete.
  // Customers: hard-delete (payment_sessions SET NULL; history retained).
  let profileMode: 'hard_deleted' | 'soft_deleted' = 'hard_deleted';

  if (target === 'driver') {
    const { error: softErr } = await admin
      .from('drivers')
      .update({
        user_id: null,
        deleted_at: new Date().toISOString(),
        driver_status: 'deleted',
        is_online: false,
        first_name: 'Deleted',
        last_name: 'Driver',
        email: `deleted+${profile_id}@onecab.invalid`,
        phone: `deleted:${profile_id}`,
        profile_photo_url: null,
        residential_address: null,
        postcode: null,
      })
      .eq('id', profile_id);

    if (softErr) {
      return jsonResponse(
        { error: `Failed to soft-delete driver profile: ${softErr.message}` },
        500,
      );
    }
    // Plate release: trg_drivers_release_vehicles_on_soft_delete scrubs
    // vehicles.license_plate when deleted_at is stamped (see migration
    // 20261106160000_release_soft_deleted_driver_vehicle_plates.sql).
    profileMode = 'soft_deleted';
  } else {
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
      // Profile is gone/detached but auth deletion failed — surface for retry.
      return jsonResponse(
        {
          error: `Profile ${profileMode}, but failed to remove auth user: ${delAuthErr.message}`,
          profile_deleted: true,
          profile_mode: profileMode,
          auth_user_deleted: false,
        },
        500,
      );
    }
    authUserDeleted = true;
  }

  // Deleting the Auth user cascades its sessions. A user who keeps another
  // profile still loses every session here, so the deleted app is signed out.
  let sessionsRevoked = authUserDeleted;
  let sessionsRevokedCount: number | null = null;
  if (!authUserDeleted) {
    const { data: revoked, error: revokeErr } = await admin.rpc('admin_revoke_user_sessions', {
      p_user_id: targetUserId,
    });
    if (revokeErr) {
      console.warn('ADMIN_DELETE_SESSION_REVOKE_FAILED', JSON.stringify({
        user_id: targetUserId,
        error: revokeErr.message,
      }));
    } else {
      sessionsRevoked = true;
      sessionsRevokedCount = typeof revoked === 'number' ? revoked : null;
    }
  }

  let deletionRequestsResolved = 0;
  if (pendingDeletionIds.length > 0) {
    const { error: resolveErr } = await admin
      .from('support_conversations')
      .update({ status: 'resolved', resolved_at: new Date().toISOString() })
      .in('id', pendingDeletionIds);
    if (resolveErr) {
      console.warn('ADMIN_DELETE_REQUEST_RESOLVE_FAILED', JSON.stringify({
        conversation_ids: pendingDeletionIds,
        error: resolveErr.message,
      }));
    } else {
      deletionRequestsResolved = pendingDeletionIds.length;
    }
  }

  // 7. Audit log
  await admin.from('audit_logs').insert({
    event_type: `${target}_hard_deleted`,
    user_id: targetUserId,
    details: {
      profile_id,
      target,
      reason: reason ?? null,
      profile_mode: profileMode,
      auth_user_deleted: authUserDeleted,
      remaining_drivers: remainingDrivers ?? 0,
      remaining_customers: remainingCustomers ?? 0,
      remaining_roles: remainingRoles ?? 0,
      sessions_revoked: sessionsRevoked,
      sessions_revoked_count: sessionsRevokedCount,
      deletion_request_ids: pendingDeletionIds,
      deletion_requests_resolved: deletionRequestsResolved,
      deleted_by: caller.id,
    },
  });

  return jsonResponse({
    success: true,
    target,
    profile_id,
    profile_mode: profileMode,
    auth_user_deleted: authUserDeleted,
    sessions_revoked: sessionsRevoked,
    deletion_requests_resolved: deletionRequestsResolved,
    remaining_profiles: {
      drivers: remainingDrivers ?? 0,
      customers: remainingCustomers ?? 0,
    },
  });
});
