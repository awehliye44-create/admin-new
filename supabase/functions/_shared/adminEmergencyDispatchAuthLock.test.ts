/**
 * Lock: admin-emergency-dispatch authorizes via user-scoped has_role only.
 * Service-role must not call has_role. No production mutations in these tests.
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { authorizeAdminEmergencyDispatch } from "./adminEmergencyDispatchAuth.ts";

const INDEX = new URL("../admin-emergency-dispatch/index.ts", import.meta.url);
const AUTH = new URL("./adminEmergencyDispatchAuth.ts", import.meta.url);

const ACTOR = "00000000-0000-4000-8000-0000000000a1";
const SPOOF = "00000000-0000-4000-8000-0000000000b2";

function mockUserClient(args: {
  userId?: string | null;
  getUserError?: Error | null;
  isAdmin?: boolean;
  roleError?: Error | null;
  onRpc?: (fn: string, params: Record<string, unknown>) => void;
}) {
  const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  return {
    client: {
      auth: {
        getUser: async (_token?: string) => {
          if (args.getUserError) {
            return { data: { user: null }, error: args.getUserError };
          }
          if (!args.userId) {
            return { data: { user: null }, error: null };
          }
          return { data: { user: { id: args.userId } }, error: null };
        },
      },
      rpc: async (fn: string, params: Record<string, unknown>) => {
        rpcCalls.push({ fn, params });
        args.onRpc?.(fn, params);
        if (args.roleError) {
          return { data: null, error: args.roleError };
        }
        return { data: args.isAdmin === true, error: null };
      },
    } as never,
    rpcCalls,
  };
}

Deno.test("source: user-scoped has_role precedes service-role client", async () => {
  const src = await Deno.readTextFile(INDEX);
  const authSrc = await Deno.readTextFile(AUTH);
  assertStringIncludes(src, "authorizeAdminEmergencyDispatch");
  assertStringIncludes(authSrc, 'userClient.rpc("has_role"');
  assertStringIncludes(authSrc, "_user_id: actorUserId");
  assertEquals(authSrc.includes("SUPABASE_SERVICE_ROLE_KEY"), false);
  assertEquals(authSrc.includes("serviceRoleKey"), false);
  assertEquals(/createClient\([^\)]*SERVICE_ROLE/i.test(authSrc), false);

  const authCall = src.indexOf("authorizeAdminEmergencyDispatch(req");
  const serviceClient = src.indexOf("createClient(supabaseUrl, serviceRoleKey)");
  const snapshot = src.indexOf("await recordDispatchWaveSnapshot");
  const dispatch = src.indexOf("await invokeSqlDispatchTripOffersIfAllowed");
  assertEquals(authCall > 0, true);
  assertEquals(serviceClient > authCall, true);
  assertEquals(snapshot > serviceClient, true);
  assertEquals(dispatch > serviceClient, true);
  assertStringIncludes(src, "Spoofed actor fields are ignored");
  // handleCORSPreflight always returns 204 — must not short-circuit POST auth.
  assertStringIncludes(src, 'if (req.method === "OPTIONS") return handleCORSPreflight()');
  assertEquals(src.includes("handleCORSPreflight(req)"), false);
});

Deno.test("missing Authorization → 401", async () => {
  const res = await authorizeAdminEmergencyDispatch(
    new Request("https://example.test", { method: "POST" }),
    { supabaseUrl: "https://example.supabase.co", anonKey: "anon" },
    {
      createUserClient: () => {
        throw new Error("user client must not be created");
      },
    },
  );
  assertEquals(res.ok, false);
  if (res.ok) return;
  assertEquals(res.response.status, 401);
  assertStringIncludes(await res.response.text(), "UNAUTHORIZED");
});

Deno.test("invalid JWT → 401", async () => {
  const { client } = mockUserClient({
    getUserError: new Error("invalid"),
  });
  const res = await authorizeAdminEmergencyDispatch(
    new Request("https://example.test", {
      method: "POST",
      headers: { Authorization: "Bearer bad-token" },
    }),
    { supabaseUrl: "https://example.supabase.co", anonKey: "anon" },
    { createUserClient: () => client },
  );
  assertEquals(res.ok, false);
  if (res.ok) return;
  assertEquals(res.response.status, 401);
});

Deno.test("customer JWT → 403", async () => {
  const { client, rpcCalls } = mockUserClient({ userId: ACTOR, isAdmin: false });
  const res = await authorizeAdminEmergencyDispatch(
    new Request("https://example.test", {
      method: "POST",
      headers: { Authorization: "Bearer customer-token" },
    }),
    { supabaseUrl: "https://example.supabase.co", anonKey: "anon" },
    { createUserClient: () => client },
  );
  assertEquals(res.ok, false);
  if (res.ok) return;
  assertEquals(res.response.status, 403);
  assertEquals(rpcCalls.length, 1);
  assertEquals(rpcCalls[0].fn, "has_role");
  assertEquals(rpcCalls[0].params._user_id, ACTOR);
});

Deno.test("driver JWT → 403", async () => {
  const { client } = mockUserClient({ userId: ACTOR, isAdmin: false });
  const res = await authorizeAdminEmergencyDispatch(
    new Request("https://example.test", {
      method: "POST",
      headers: { Authorization: "Bearer driver-token" },
    }),
    { supabaseUrl: "https://example.supabase.co", anonKey: "anon" },
    { createUserClient: () => client },
  );
  assertEquals(res.ok, false);
  if (res.ok) return;
  assertEquals(res.response.status, 403);
});

Deno.test("active staff without admin role → 403", async () => {
  const { client } = mockUserClient({ userId: ACTOR, isAdmin: false });
  const res = await authorizeAdminEmergencyDispatch(
    new Request("https://example.test", {
      method: "POST",
      headers: { Authorization: "Bearer staff-token" },
    }),
    { supabaseUrl: "https://example.supabase.co", anonKey: "anon" },
    { createUserClient: () => client },
  );
  assertEquals(res.ok, false);
  if (res.ok) return;
  assertEquals(res.response.status, 403);
});

Deno.test("inactive staff without admin role → 403 (has_role remains the gate)", async () => {
  const { client } = mockUserClient({ userId: ACTOR, isAdmin: false });
  const res = await authorizeAdminEmergencyDispatch(
    new Request("https://example.test", {
      method: "POST",
      headers: { Authorization: "Bearer inactive-staff-token" },
    }),
    { supabaseUrl: "https://example.supabase.co", anonKey: "anon" },
    { createUserClient: () => client },
  );
  assertEquals(res.ok, false);
  if (res.ok) return;
  assertEquals(res.response.status, 403);
});

Deno.test("service-role Bearer is not a user session → 401", async () => {
  const { client, rpcCalls } = mockUserClient({
    getUserError: new Error("not a user jwt"),
  });
  const res = await authorizeAdminEmergencyDispatch(
    new Request("https://example.test", {
      method: "POST",
      headers: { Authorization: "Bearer service-key-not-user" },
    }),
    { supabaseUrl: "https://example.supabase.co", anonKey: "anon" },
    { createUserClient: () => client },
  );
  assertEquals(res.ok, false);
  if (res.ok) return;
  assertEquals(res.response.status, 401);
  assertEquals(rpcCalls.length, 0);
});

Deno.test("authorized admin reaches post-auth boundary with actor from getUser", async () => {
  const { client, rpcCalls } = mockUserClient({ userId: ACTOR, isAdmin: true });
  const res = await authorizeAdminEmergencyDispatch(
    new Request("https://example.test", {
      method: "POST",
      headers: { Authorization: "Bearer admin-token" },
      body: JSON.stringify({ trip_id: "t1", user_id: SPOOF, actor_id: SPOOF }),
    }),
    { supabaseUrl: "https://example.supabase.co", anonKey: "anon" },
    { createUserClient: () => client },
  );
  assertEquals(res.ok, true);
  if (!res.ok) return;
  assertEquals(res.actorUserId, ACTOR);
  assertEquals(rpcCalls.length, 1);
  assertEquals(rpcCalls[0].fn, "has_role");
  assertEquals(rpcCalls[0].params._user_id, ACTOR);
  assertEquals(rpcCalls[0].params._role, "admin");
  assertEquals(rpcCalls[0].params._user_id === SPOOF, false);
});

Deno.test("has_role is never invoked on a service-role factory", async () => {
  const authSrc = await Deno.readTextFile(AUTH);
  assertEquals(/createClient\([^\)]*SERVICE_ROLE/i.test(authSrc), false);
  assertEquals(authSrc.includes("serviceRoleKey"), false);
  assertStringIncludes(authSrc, "userClient.rpc");
});
