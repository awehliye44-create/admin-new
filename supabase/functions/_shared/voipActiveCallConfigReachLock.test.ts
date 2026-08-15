/**
 * Lock: trip-communication-config must surface active VoIP for callee poll-join.
 * Missing findActiveVoipCallLog left active_call=null → callee never rang.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("voipCallLogs exports findActiveVoipCallLog SSOT", async () => {
  const src = await Deno.readTextFile(new URL("./voipCallLogs.ts", import.meta.url));
  assertEquals(src.includes("export async function findActiveVoipCallLog"), true);
  assertEquals(src.includes('.from("voip_call_logs")'), true);
  assertEquals(src.includes("initiator_user_id"), true);
});

Deno.test("tripCommunicationActor exists for config deploy", async () => {
  const src = await Deno.readTextFile(
    new URL("./tripCommunicationActor.ts", import.meta.url),
  );
  assertEquals(src.includes("export async function resolveTripCommunicationActor"), true);
});

Deno.test("trip-communication-config imports findActiveVoipCallLog and projects real status", async () => {
  const src = await Deno.readTextFile(
    new URL("../trip-communication-config/index.ts", import.meta.url),
  );
  assertEquals(src.includes("findActiveVoipCallLog"), true);
  assertEquals(src.includes('from "../_shared/voipCallLogs.ts"'), true);
  assertEquals(/status:\s*activeLog\.status/.test(src), true);
  assertEquals(src.includes('status: "active" as const'), false);
});
