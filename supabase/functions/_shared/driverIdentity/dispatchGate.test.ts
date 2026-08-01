import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { getIdentityDispatchRejectReason } from "./dispatchGate.ts";

Deno.test("identity dispatch gate returns null when not blocked", async () => {
  const supabase = {
    rpc: async () => ({
      data: { blocking: false, dispatch_blocked: false, code: "OK" },
      error: null,
    }),
  };
  assertEquals(await getIdentityDispatchRejectReason(supabase, "d1"), null);
});

Deno.test("deferred active work still blocks NEW offers", async () => {
  const supabase = {
    rpc: async () => ({
      data: {
        blocking: false,
        dispatch_blocked: true,
        code: "IDENTITY_VERIFICATION_DEFERRED_ACTIVE_WORK",
      },
      error: null,
    }),
  };
  assertEquals(
    await getIdentityDispatchRejectReason(supabase, "d1"),
    "identity_verification_required",
  );
});

Deno.test("rejected maps to identity_verification_blocked", async () => {
  const supabase = {
    rpc: async () => ({
      data: {
        blocking: true,
        dispatch_blocked: true,
        code: "IDENTITY_VERIFICATION_BLOCKED",
      },
      error: null,
    }),
  };
  assertEquals(
    await getIdentityDispatchRejectReason(supabase, "d1"),
    "identity_verification_blocked",
  );
});
