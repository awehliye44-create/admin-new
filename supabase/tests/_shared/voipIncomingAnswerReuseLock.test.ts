/**
 * Lock: livekit-voip-token must return `created` so clients can convert a
 * reused start into Answer UI (presentIncoming) instead of outbound Calling…
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("livekit-voip-token response includes created boolean", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/livekit-voip-token/index.ts", import.meta.url),
  );
  assertEquals(src.includes("created = createdSession.created"), true);
  assertEquals(src.includes("created,"), true);
  assertEquals(src.includes("createOrReuseVoipSession"), true);
});

Deno.test("incomingCallPush uses dedicated VoIP channels (not trip_updates)", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/incomingCallPush.ts", import.meta.url),
  );
  assertEquals(src.includes("onecab_incoming_voip_v1"), true);
  assertEquals(src.includes("onecab_incoming_voip_v2"), true);
  assertEquals(/channel_id:\s*"trip_updates"/.test(src), false);
});
