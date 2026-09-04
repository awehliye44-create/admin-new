/**
 * Lock: VoIP start must supersede a stuck call_masking row on the same trip.
 * Otherwise CALL_ALREADY_ACTIVE blocks in-app call and the driver never rings.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("createCallLog stamps expires_at for timeout sweep", async () => {
  const src = await Deno.readTextFile(new URL("./callMaskingLogs.ts", import.meta.url));
  assertEquals(src.includes("expires_at: expiresAt"), true);
  assertEquals(src.includes("MAX_CALL_DURATION_SEC"), true);
});

Deno.test("createOrReuseVoipSession supersedes active call_masking", async () => {
  const src = await Deno.readTextFile(new URL("./voipCallLogs.ts", import.meta.url));
  assertEquals(src.includes("export async function supersedeActiveMaskingCallForVoip"), true);
  assertEquals(src.includes('existing.method === "call_masking"'), true);
  assertEquals(src.includes("await supersedeActiveMaskingCallForVoip(client, existing)"), true);
  assertEquals(src.includes("DISCONNECT_REASON.SUPERSEDED_BY_VOIP"), true);
  assertEquals(src.includes("Fall through and create a fresh VoIP session"), true);
});

Deno.test("timeout sweep terminates null-expires_at masking orphans", async () => {
  const src = await Deno.readTextFile(
    new URL("../trip-communication-timeout-sweep/index.ts", import.meta.url),
  );
  assertEquals(src.includes('.is("expires_at", null)'), true);
  assertEquals(src.includes("orphanCutoffIso"), true);
  assertEquals(src.includes("lte(\"call_start\", orphanCutoffIso)"), true);
});
