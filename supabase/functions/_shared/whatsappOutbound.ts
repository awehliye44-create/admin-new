/**
 * Outbound WhatsApp Cloud API messages (server-side token only).
 */

export type WhatsAppSendResult =
  | { ok: true; messageId: string | null }
  | { ok: false; status: number; error: string };

type WhatsAppCredentials = {
  accessToken: string;
  phoneNumberId: string;
};

export function readWhatsAppSendCredentials(): WhatsAppCredentials | null {
  const accessToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN")?.trim() ?? "";
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")?.trim() ?? "";
  if (!accessToken || !phoneNumberId) return null;
  return { accessToken, phoneNumberId };
}

async function postWhatsAppMessage(
  creds: WhatsAppCredentials,
  body: Record<string, unknown>,
): Promise<WhatsAppSendResult> {
  const url = `https://graph.facebook.com/v21.0/${creds.phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  if (!response.ok) {
    console.error("[whatsapp-webhook] outbound failed", {
      status: response.status,
      body_prefix: raw.slice(0, 240),
    });
    return { ok: false, status: response.status, error: "send_failed" };
  }
  try {
    const parsed = JSON.parse(raw) as { messages?: Array<{ id?: string }> };
    return { ok: true, messageId: parsed.messages?.[0]?.id ?? null };
  } catch {
    return { ok: true, messageId: null };
  }
}

export async function sendWhatsAppTextMessage(
  creds: WhatsAppCredentials,
  toWaId: string,
  text: string,
  opts: { previewUrl?: boolean } = {},
): Promise<WhatsAppSendResult> {
  return postWhatsAppMessage(creds, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toWaId,
    type: "text",
    text: { preview_url: opts.previewUrl === true, body: text },
  });
}

export async function sendWhatsAppWelcomeMenu(
  creds: WhatsAppCredentials,
  toWaId: string,
): Promise<WhatsAppSendResult> {
  return postWhatsAppMessage(creds, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toWaId,
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text:
          "Welcome to ONECAB.\n\nHow can we help you today?\n\nChoose an option below.",
      },
      action: {
        buttons: [
          { type: "reply", reply: { id: "book_ride", title: "Book a ride" } },
          { type: "reply", reply: { id: "track_booking", title: "Track booking" } },
          { type: "reply", reply: { id: "customer_support", title: "Support" } },
        ],
      },
    },
  });
}

export async function sendWhatsAppCompactMenuHint(
  creds: WhatsAppCredentials,
  toWaId: string,
): Promise<WhatsAppSendResult> {
  return sendWhatsAppTextMessage(
    creds,
    toWaId,
    "Please choose an option:\n• Book a ride\n• Track my booking\n• Customer support\n\nReply with 1, 2, or 3, or tap a menu button.",
  );
}
