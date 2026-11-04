/**
 * Twilio Messaging SMS (transactional freeform).
 * Auth phone OTP uses Twilio Verify via GoTrue; this path is Messaging API only.
 *
 * Env (Edge secrets):
 * - TWILIO_ACCOUNT_SID
 * - TWILIO_AUTH_TOKEN
 * - TWILIO_MESSAGING_SERVICE_SID and/or TWILIO_FROM_NUMBER (E.164)
 */
export type TwilioSmsResult =
  | { ok: true; messageId?: string }
  | { ok: false; error: string }
  | { skipped: true; reason: string };

function normalizeE164(phone: string): string | null {
  const raw = phone.trim();
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+") && digits.length >= 10) return digits;
  const only = raw.replace(/[^\d]/g, "");
  if (!only) return null;
  // UK national without country code → +44
  if (only.startsWith("0") && only.length >= 10) return `+44${only.slice(1)}`;
  if (only.startsWith("44") && only.length >= 11) return `+${only}`;
  if (only.length >= 10) return `+${only}`;
  return null;
}

export async function sendTwilioSms(args: {
  phoneE164: string;
  body: string;
}): Promise<TwilioSmsResult> {
  // Prefer Edge TWILIO_* secrets; also accept GoTrue-style SMS_TWILIO_* aliases.
  const accountSid = (
    Deno.env.get("TWILIO_ACCOUNT_SID") ??
    Deno.env.get("SMS_TWILIO_ACCOUNT_SID") ??
    ""
  ).trim();
  const authToken = (
    Deno.env.get("TWILIO_AUTH_TOKEN") ??
    Deno.env.get("SMS_TWILIO_AUTH_TOKEN") ??
    ""
  ).trim();
  const messagingServiceSid = (
    Deno.env.get("TWILIO_MESSAGING_SERVICE_SID") ??
    Deno.env.get("TWILIO_MESSAGE_SERVICE_SID") ??
    Deno.env.get("SMS_TWILIO_MESSAGE_SERVICE_SID") ??
    Deno.env.get("SMS_TWILIO_MESSAGING_SERVICE_SID") ??
    ""
  ).trim();
  const fromNumber = (
    Deno.env.get("TWILIO_FROM_NUMBER") ??
    Deno.env.get("TWILIO_PHONE_NUMBER") ??
    ""
  ).trim();

  if (!accountSid || !authToken) {
    return { skipped: true, reason: "sms_provider_not_configured" };
  }
  if (!messagingServiceSid && !fromNumber) {
    return { skipped: true, reason: "sms_sender_not_configured" };
  }

  const to = normalizeE164(args.phoneE164);
  if (!to) return { skipped: true, reason: "invalid_phone" };

  const body = new URLSearchParams();
  body.set("To", to);
  body.set("Body", args.body.slice(0, 1500));
  if (messagingServiceSid) {
    body.set("MessagingServiceSid", messagingServiceSid);
  } else {
    body.set("From", normalizeE164(fromNumber) ?? fromNumber);
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
  const basic = btoa(`${accountSid}:${authToken}`);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const raw = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    } catch {
      parsed = { raw };
    }
    if (!response.ok) {
      const msg = String(parsed.message ?? parsed.error_message ?? raw).slice(0, 200);
      return { ok: false, error: `twilio_http_${response.status}:${msg}` };
    }
    const sid = String(parsed.sid ?? "").trim();
    return { ok: true, messageId: sid || undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
