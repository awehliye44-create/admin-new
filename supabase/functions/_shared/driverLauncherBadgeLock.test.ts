/**
 * LOCK — Driver push must never set a non-zero home-screen badge.
 * Notifications may still alert; aps.badge must stay 0.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const SRC = await Deno.readTextFile(
  new URL("../send-driver-notification/index.ts", import.meta.url),
);

Deno.test("send-driver-notification never sets aps.badge > 0", () => {
  assertEquals(/badge:\s*[1-9]/.test(SRC), false);
  assertEquals(SRC.includes("badge: 0"), true);
  assertEquals(SRC.includes("Driver is not a chat app"), true);
});
