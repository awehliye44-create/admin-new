import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

async function read(pathFromRepoRoot: string): Promise<string> {
  const repoRoot = new URL("../../../", import.meta.url);
  return await Deno.readTextFile(new URL(pathFromRepoRoot, repoRoot));
}

Deno.test("website-support-chat remains the Live Chat SSOT for Corporate", async () => {
  const edge = await read("supabase/functions/website-support-chat/index.ts");
  assertEquals(edge.includes('channel: "website"'), true);
  assertEquals(edge.includes('source === "corporate"'), true);
  assertEquals(edge.includes("Corporate website"), true);
  assertEquals(edge.includes("guest_session_token"), true);
  assertEquals(edge.includes("customer_id"), true);
  assertEquals(edge.includes("SUPPORT_UNAVAILABLE"), true);
});

Deno.test("corporate hub wires SupportWidget to website-support-chat", async () => {
  const hubRoot = new URL("../../../../onecab-central-hub/", import.meta.url);
  const client = await Deno.readTextFile(new URL("src/lib/websiteSupport.ts", hubRoot));
  const widget = await Deno.readTextFile(new URL("src/components/SupportWidget.tsx", hubRoot));
  const app = await Deno.readTextFile(new URL("src/App.tsx", hubRoot));

  assertEquals(client.includes('SUPPORT_SESSION_KEY = "onecab_corporate_support_session"'), true);
  assertEquals(client.includes('"website-support-chat"'), true);
  assertEquals(client.includes('"admin-support-status"'), true);
  assertEquals(client.includes('source: "corporate"'), true);
  assertEquals(widget.includes("websiteSupport"), true);
  assertEquals(app.includes("<SupportWidget"), true);
  assertEquals(client.includes("SUPABASE_SERVICE_ROLE"), false);
  assertEquals(widget.includes("SUPABASE_SERVICE_ROLE"), false);
});
