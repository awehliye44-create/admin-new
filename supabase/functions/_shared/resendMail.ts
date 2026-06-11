export interface ResendAttachment {
  filename: string;
  content: string;
  contentType?: string;
}

const VERIFIED_SEND_DOMAINS = new Set(["onecab.net", "resend.dev"]);
const DEFAULT_FROM = "ONECAB <noreply@onecab.net>";

function getResendApiKey(): string | undefined {
  const raw = Deno.env.get("RESEND_API_KEY");
  if (!raw) return undefined;
  return raw.trim().replace(/^["']|["']$/g, "") || undefined;
}

function parseEmailAddress(value: string): { name: string; email: string } | null {
  const trimmed = value.trim();
  const bracketed = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
  if (bracketed) {
    return { name: bracketed[1].trim(), email: bracketed[2].trim() };
  }
  if (trimmed.includes("@")) {
    return { name: "ONECAB", email: trimmed };
  }
  return null;
}

function emailDomain(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

function isVerifiedSendDomain(email: string): boolean {
  const domain = emailDomain(email);
  return VERIFIED_SEND_DOMAINS.has(domain) || domain.endsWith(".resend.dev");
}

function getDefaultFrom(): string {
  const raw = Deno.env.get("RESEND_FROM_EMAIL");
  if (!raw) return DEFAULT_FROM;
  const trimmed = raw.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return DEFAULT_FROM;

  const parsed = parseEmailAddress(trimmed);
  if (parsed && isVerifiedSendDomain(parsed.email)) {
    return trimmed;
  }

  console.warn("[resendMail] RESEND_FROM_EMAIL is not on a verified domain; using onecab.net default", {
    configured: trimmed,
  });
  return DEFAULT_FROM;
}

function getVerifiedFromAddress(displayName?: string): string {
  const defaultFrom = getDefaultFrom();
  const parsed = parseEmailAddress(defaultFrom);
  if (!parsed) return defaultFrom;
  const name = (displayName || parsed.name || "ONECAB").trim();
  return `${name} <${parsed.email}>`;
}

function getReplyTo(): string | undefined {
  const raw = Deno.env.get("RESEND_REPLY_TO_EMAIL");
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/^["']|["']$/g, "");
  if (!trimmed.includes("@")) return undefined;
  if (!isVerifiedSendDomain(trimmed)) {
    console.warn("[resendMail] RESEND_REPLY_TO_EMAIL is not on a verified domain; ignoring", {
      configured: trimmed,
    });
    return undefined;
  }
  return trimmed;
}

/** Always use verified RESEND_FROM_EMAIL (onecab.net), never admin @onecab.com. */
export function formatResendFromAddress(companyName: string, _companyEmail?: string): string {
  return getVerifiedFromAddress(companyName);
}

function resolveReplyTo(explicit?: string): string | undefined {
  const envReplyTo = getReplyTo();
  const candidate = (explicit || envReplyTo || "").trim();
  if (!candidate.includes("@")) return envReplyTo;

  if (!isVerifiedSendDomain(candidate)) {
    return envReplyTo;
  }
  return candidate;
}

export async function sendResendEmail(args: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
  attachments?: ResendAttachment[];
  tag?: string;
}): Promise<{ ok: true; id?: string } | { ok: false; message: string }> {
  const apiKey = getResendApiKey();
  if (!apiKey) {
    console.error("Resend email failed: RESEND_API_KEY is not configured");
    return { ok: false, message: "RESEND_API_KEY is not configured" };
  }
  if (!apiKey.startsWith("re_")) {
    console.error("RESEND_API_KEY has invalid format (expected re_ prefix)");
    return { ok: false, message: "RESEND_API_KEY is misconfigured" };
  }

  const fromAddress = (() => {
    const requested = args.from ?? getDefaultFrom();
    const parsed = parseEmailAddress(requested);
    if (!parsed || !isVerifiedSendDomain(parsed.email)) {
      return getVerifiedFromAddress(parsed?.name);
    }
    return requested;
  })();

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress,
      to: [args.to],
      subject: args.subject,
      html: args.html,
      ...(args.text ? { text: args.text } : {}),
      ...(resolveReplyTo(args.replyTo) ? { reply_to: resolveReplyTo(args.replyTo) } : {}),
      ...(args.attachments?.length ? {
        attachments: args.attachments.map((attachment) => ({
          filename: attachment.filename,
          content: attachment.content,
          ...(attachment.contentType ? { content_type: attachment.contentType } : {}),
        })),
      } : {}),
      tags: [{ name: "category", value: args.tag ?? "driver_monthly_invoice" }],
    }),
  });

  let payload: Record<string, unknown> = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const raw = typeof payload?.message === "string" ? payload.message : "Resend email failed";
    console.error("Resend email failed:", payload);
    return { ok: false, message: raw };
  }

  return { ok: true, id: payload?.id as string | undefined };
}
