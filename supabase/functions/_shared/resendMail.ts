export interface ResendAttachment {
  filename: string;
  content: string;
}

function getResendApiKey(): string | undefined {
  const raw = Deno.env.get("RESEND_API_KEY");
  if (!raw) return undefined;
  return raw.trim().replace(/^["']|["']$/g, "") || undefined;
}

function getDefaultFrom(): string {
  const raw = Deno.env.get("RESEND_FROM_EMAIL");
  if (!raw) return "ONECAB <onboarding@resend.dev>";
  return raw.trim().replace(/^["']|["']$/g, "") || "ONECAB <onboarding@resend.dev>";
}

function getReplyTo(): string | undefined {
  const raw = Deno.env.get("RESEND_REPLY_TO_EMAIL");
  if (!raw) return undefined;
  return raw.trim().replace(/^["']|["']$/g, "") || undefined;
}

export async function sendResendEmail(args: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
  attachments?: ResendAttachment[];
  tag?: string;
}): Promise<{ ok: true; id?: string } | { ok: false; message: string }> {
  const apiKey = getResendApiKey();
  if (!apiKey) return { ok: false, message: "RESEND_API_KEY is not configured" };

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: args.from ?? getDefaultFrom(),
      to: [args.to],
      subject: args.subject,
      html: args.html,
      ...(args.text ? { text: args.text } : {}),
      ...(getReplyTo() ? { reply_to: getReplyTo() } : {}),
      ...(args.attachments?.length ? { attachments: args.attachments } : {}),
      tags: [{ name: "category", value: args.tag ?? "driver_monthly_invoice" }],
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const raw = typeof payload?.message === "string" ? payload.message : "Failed to send email";
    return { ok: false, message: raw };
  }
  return { ok: true, id: payload?.id };
}
