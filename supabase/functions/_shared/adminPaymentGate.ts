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
  actor_email?: string | null;
  actor_role?: string | null;
  actor_is_owner?: boolean;
  auth_source?: string | null;
}
export interface GateError {
  ok: false;
  response: Response;
}

/** Finance execution / mutation roles — matches UI finance action policy. */
export const FINANCE_EXECUTION_ROLES = new Set([
  "super_admin",
  "admin",
  "finance_manager",
]);

export const FINANCE_EXECUTION_PAGE_SLUGS = {
  PAYOUT_LEDGER: "payout-ledger",
  PAYMENT_PROVIDERS: "payment-providers",
  DRIVER_WALLET_LEDGER: "driver-wallet-ledger",
  COMPANY_OUTGOING_TRANSFERS: "payout-ledger",
} as const;

/**
 * Cron/internal OR finance-role staff with page access.
 * Rejects unauthenticated callers and ordinary support/operator roles.
 */
export async function requireFinanceExecutionAuth(
  req: Request,
  options?: {
    pageSlug?: string;
    cronBody?: Record<string, unknown>;
    /** Reject legacy user_roles.admin JWT without active staff_profiles finance role. */
    requireStaffFinanceProfile?: boolean;
  },
): Promise<(GateResult & { actor_role?: string | null; auth_source?: string }) | GateError> {
  const pageSlug = options?.pageSlug ?? FINANCE_EXECUTION_PAGE_SLUGS.PAYOUT_LEDGER;
  const { assertCronOrServiceRoleAuth } = await import("./cronEdgeAuth.ts");
  const { isCompanyFundsRejectedStaffRole } = await import("./companyFundsAuthoritySSOT.ts");

  const cronAuth = await assertCronOrServiceRoleAuth(req, options?.cronBody ?? {});
  if (cronAuth.ok) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    return {
      ok: true,
      supabase,
      userId: "service-role",
      actor_role: "service_role",
      auth_source: cronAuth.source,
    };
  }

  const adminGate = await requireAdmin(req);
  if (!adminGate.ok) return adminGate;

  const { data: staffRow } = await adminGate.supabase
    .from("staff_profiles")
    .select("role, is_active, is_owner, full_name")
    .eq("user_id", adminGate.userId)
    .eq("is_active", true)
    .maybeSingle();

  if (options?.requireStaffFinanceProfile && !staffRow) {
    return {
      ok: false,
      response: new Response(JSON.stringify({
        error: "Forbidden — active staff finance profile required",
        code: "FINANCE_STAFF_PROFILE_REQUIRED",
      }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }),
    };
  }

  const role = staffRow?.role ? String(staffRow.role) : "super_admin";
  if (isCompanyFundsRejectedStaffRole(role)) {
    return {
      ok: false,
      response: new Response(JSON.stringify({
        error: "Forbidden — finance execution role required",
        code: "FINANCE_EXECUTION_FORBIDDEN",
        role,
      }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }),
    };
  }

  if (options?.requireStaffFinanceProfile && !FINANCE_EXECUTION_ROLES.has(role)) {
    return {
      ok: false,
      response: new Response(JSON.stringify({
        error: "Forbidden — finance execution role required",
        code: "FINANCE_EXECUTION_FORBIDDEN",
        role,
      }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }),
    };
  }

  if (!options?.requireStaffFinanceProfile && !FINANCE_EXECUTION_ROLES.has(role)) {
    return {
      ok: false,
      response: new Response(JSON.stringify({
        error: "Forbidden — finance execution role required",
        code: "FINANCE_EXECUTION_FORBIDDEN",
        role,
      }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }),
    };
  }

  const pageGate = await requirePageAccess({
    ...adminGate,
    actor_email: adminGate.actor_email,
    actor_role: role,
    actor_is_owner: staffRow?.is_owner === true,
  }, pageSlug);
  if (!pageGate.ok) return pageGate;

  const { data: authUser } = await adminGate.supabase.auth.admin.getUserById(adminGate.userId)
    .catch(() => ({ data: { user: null } }));

  console.info("[finance-auth] execution allowed", {
    user_id: pageGate.userId,
    role,
    page: pageSlug,
    is_owner: staffRow?.is_owner === true,
    strict_staff: options?.requireStaffFinanceProfile === true,
  });

  return {
    ...pageGate,
    actor_role: role,
    actor_email: authUser?.user?.email ?? adminGate.actor_email ?? null,
    actor_is_owner: staffRow?.is_owner === true,
    auth_source: "staff_jwt",
  };
}

/**
 * Finance read/list gate — same finance roles + page access, strict staff profile.
 * Used for company-funds read surfaces (no owner tier required).
 */
export async function requireFinancePageReadAuth(
  req: Request,
  pageSlug = FINANCE_EXECUTION_PAGE_SLUGS.PAYOUT_LEDGER,
): Promise<(GateResult & { actor_role?: string | null; auth_source?: string }) | GateError> {
  return requireFinanceExecutionAuth(req, {
    pageSlug,
    requireStaffFinanceProfile: true,
  });
}

/**
 * Owner-tier gate for production reserve activation / owner-only disable.
 */
export async function requireOwnerTierAuth(
  req: Request,
  options?: {
    pageSlug?: string;
    allowSuperAdmin?: boolean;
  },
): Promise<(GateResult & { actor_role?: string | null; auth_source?: string }) | GateError> {
  const pageSlug = options?.pageSlug ?? FINANCE_EXECUTION_PAGE_SLUGS.PAYOUT_LEDGER;
  const gate = await requireFinanceExecutionAuth(req, {
    pageSlug,
    requireStaffFinanceProfile: true,
  });
  if (!gate.ok) return gate;
  if (gate.userId === "service-role") {
    return {
      ok: false,
      response: new Response(JSON.stringify({
        error: "Forbidden — owner-tier human approval required",
        code: "OWNER_TIER_REQUIRED",
      }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }),
    };
  }
  if (gate.actor_is_owner === true) return gate;
  if (options?.allowSuperAdmin !== false && gate.actor_role === "super_admin") return gate;
  return {
    ok: false,
    response: new Response(JSON.stringify({
      error: "Forbidden — owner or super_admin required",
      code: "OWNER_TIER_REQUIRED",
      role: gate.actor_role ?? null,
    }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }),
  };
}

export function buildFinanceActorAuditContext(
  gate: GateResult & { actor_role?: string | null; auth_source?: string },
): {
  actor_user_id: string | null;
  actor_email: string | null;
  actor_role: string | null;
  actor_is_owner: boolean;
  auth_source: string | null;
} {
  return {
    actor_user_id: gate.userId === "service-role" ? null : gate.userId,
    actor_email: gate.actor_email ?? null,
    actor_role: gate.actor_role ?? null,
    actor_is_owner: gate.actor_is_owner === true,
    auth_source: gate.auth_source ?? null,
  };
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

  return { ok: true, supabase, userId: user.id, actor_email: user.email ?? null };
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
