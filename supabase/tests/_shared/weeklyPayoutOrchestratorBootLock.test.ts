/**
 * Lock: canonical weekly orchestrator boots and cron targets it (not Slice 5 409).
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../", import.meta.url);

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, ROOT));
}

Deno.test("orchestrator imports relayApprovedDriverPayoutPaymentStatus not stale alias", async () => {
  const orchestrator = await read("admin-execute-weekly-payout-occurrence/index.ts");
  const relay = await read("_shared/revolutBusinessRelayClient.ts");
  assertStringIncludes(orchestrator, "relayApprovedDriverPayoutPaymentStatus");
  assertStringIncludes(relay, "export async function relayApprovedDriverPayoutPaymentStatus");
  assertEquals(orchestrator.includes("relayDriverPayoutPaymentStatus"), false);
});

Deno.test("orchestrator exposes boot health probe", async () => {
  const src = await read("admin-execute-weekly-payout-occurrence/index.ts");
  assertStringIncludes(src, 'body.health === true');
  assertStringIncludes(src, 'boot: "ok"');
});

Deno.test("Slice 5 scheduler forwards when LIVE+TRANSPORT enabled", async () => {
  const src = await read("admin-weekly-payout-scheduler/index.ts");
  assertStringIncludes(src, "admin-execute-weekly-payout-occurrence");
  assertStringIncludes(src, "forwarded_from");
  assertEquals(src.includes("slice5_refuses_enabled_execution_flags"), false);
});

Deno.test("cron migration targets canonical orchestrator URL", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20260832010000_weekly_payout_orchestrator_claim_cron.sql", import.meta.url),
  );
  assertStringIncludes(sql, "admin-execute-weekly-payout-occurrence");
  assertStringIncludes(sql, "edge_weekly_payout_orchestrator_url");
});
