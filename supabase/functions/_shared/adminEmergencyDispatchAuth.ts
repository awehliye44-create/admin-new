import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { errorResponse } from "./security.ts";

export type AdminEmergencyDispatchAuthOk = {
  ok: true;
  actorUserId: string;
  userClient: SupabaseClient;
};

export type AdminEmergencyDispatchAuth =
  | AdminEmergencyDispatchAuthOk
  | { ok: false; response: Response };

type AuthDeps = {
  createUserClient: (args: {
    supabaseUrl: string;
    anonKey: string;
    authHeader: string;
  }) => SupabaseClient;
};

const defaultDeps: AuthDeps = {
  createUserClient: ({ supabaseUrl, anonKey, authHeader }) =>
    createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: authHeader } },
    }),
};

/**
 * Authorize admin-emergency-dispatch with the caller's JWT only.
 * Actor UUID comes exclusively from auth.getUser().
 * has_role runs on the user-scoped client so auth.uid() matches the actor.
 * Privileged database clients must not be used for this authorization call.
 */
export async function authorizeAdminEmergencyDispatch(
  req: Request,
  env: {
    supabaseUrl: string | undefined;
    anonKey: string | undefined;
  },
  deps: AuthDeps = defaultDeps,
): Promise<AdminEmergencyDispatchAuth> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      ok: false,
      response: errorResponse("UNAUTHORIZED", "Missing authorization", 401),
    };
  }

  if (!env.supabaseUrl || !env.anonKey) {
    return {
      ok: false,
      response: errorResponse("INTERNAL_ERROR", "Auth environment unavailable", 500),
    };
  }

  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) {
    return {
      ok: false,
      response: errorResponse("UNAUTHORIZED", "Missing authorization", 401),
    };
  }

  const userClient = deps.createUserClient({
    supabaseUrl: env.supabaseUrl,
    anonKey: env.anonKey,
    authHeader,
  });

  const { data: userData, error: userError } = await userClient.auth.getUser(token);
  if (userError || !userData?.user?.id) {
    return {
      ok: false,
      response: errorResponse("UNAUTHORIZED", "Invalid token", 401),
    };
  }

  const actorUserId = userData.user.id;

  // Authorization oracle must run as the authenticated actor.
  const { data: isAdmin, error: roleError } = await userClient.rpc("has_role", {
    _user_id: actorUserId,
    _role: "admin",
  });
  if (roleError || !isAdmin) {
    return {
      ok: false,
      response: errorResponse("FORBIDDEN", "Admin role required", 403),
    };
  }

  return { ok: true, actorUserId, userClient };
}
