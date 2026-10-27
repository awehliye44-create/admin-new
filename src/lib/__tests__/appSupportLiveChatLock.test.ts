/**
 * LOCK — App Live Chat reuses Admin support_conversations (channel = in_app).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "../../..");

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("App Live Chat admin lock", () => {
  it("registers app-support-chat and app-support-notify Edge functions", () => {
    const chat = read("supabase/functions/app-support-chat/index.ts");
    expect(chat).toContain('channel: "in_app"');
    expect(chat).toContain("Booking or trip");
    expect(chat).toContain("Trips or offers");
    expect(chat).toContain("Account suspension");
    expect(chat).toContain('`${roleTag}: ${subjectRaw}`');

    const notify = read("supabase/functions/app-support-notify/index.ts");
    expect(notify).toContain("send-customer-notification");
    expect(notify).toContain("send-driver-notification");
    expect(notify).toContain('kind === "closed"');

    const config = read("supabase/config.toml");
    expect(config).toContain("[functions.app-support-chat]");
    expect(config).toContain("[functions.app-support-notify]");
  });

  it("wires Close & notify for in_app in Live Chat UI", () => {
    const area = read("src/components/chat/ChatMessageArea.tsx");
    expect(area).toContain("onInAppResolve");
    expect(area).toContain('conversation.channel === "in_app"');
    expect(area).toContain("Close & notify");
    expect(area).toContain("Customer app");
    expect(area).toContain("Driver app");

    const hook = read("src/hooks/useSupportChat.ts");
    expect(hook).toContain("useResolveInAppConversation");
    expect(hook).toContain("app-support-notify");
  });

  it("keeps Tickets free of Live Chat in_app rows", () => {
    const tickets = read("src/pages/Tickets.tsx");
    expect(tickets).toMatch(/whatsapp,\s*website,\s*in_app|whatsapp,website,in_app/);
  });
});
