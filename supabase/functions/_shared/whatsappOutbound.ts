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

export const WHATSAPP_WELCOME_TEXT =
  "Welcome to *ONECAB*. 👋\nChoose an option below to continue.";

export const WHATSAPP_WELCOME_CARD_BODY =
  "*Reliable. Safe. Always On Time.*\nMilton Keynes’ trusted taxi service. Book in seconds. Ride with confidence.";

/** Single interactive body — greeting + card copy (avoids a second Graph round-trip). */
export const WHATSAPP_WELCOME_INTERACTIVE_BODY =
  `${WHATSAPP_WELCOME_TEXT}\n\n${WHATSAPP_WELCOME_CARD_BODY}`;

export const WHATSAPP_WELCOME_BUTTONS = [
  { type: "reply" as const, reply: { id: "book_ride", title: "🚕 Book a ride" } },
  { type: "reply" as const, reply: { id: "track_booking", title: "📍 Track my booking" } },
  { type: "reply" as const, reply: { id: "customer_support", title: "🎧 Customer support" } },
];

export function readWhatsAppSendCredentials(): WhatsAppCredentials | null {
  const accessToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN")?.trim() ?? "";
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")?.trim() ?? "";
  if (!accessToken || !phoneNumberId) return null;
  return { accessToken, phoneNumberId };
}

export function readWhatsAppWelcomeHeaderImageUrl(): string {
  const override = Deno.env.get("WHATSAPP_WELCOME_HEADER_IMAGE_URL")?.trim() ?? "";
  if (override) return override;
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
  if (!supabaseUrl) return "";
  return `${supabaseUrl}/storage/v1/object/public/whatsapp-public/welcome-header.jpg`;
}

// Keep outbound tight: hung Meta calls must not push customer-visible p95 into tens of seconds.
// Fail fast so the webhook path can finish / retry cleanly.
const WHATSAPP_OUTBOUND_TIMEOUT_MS = 8_000;

function logGraphError(raw: string, status: number): void {
  let meta: Record<string, unknown> = { status, body_prefix: raw.slice(0, 240) };
  try {
    const parsed = JSON.parse(raw) as { error?: Record<string, unknown> };
    const err = parsed.error;
    if (err && typeof err === "object") {
      meta = {
        status,
        code: err.code ?? null,
        error_subcode: err.error_subcode ?? null,
        type: err.type ?? null,
        message: err.message ?? null,
        fbtrace_id: err.fbtrace_id ?? null,
      };
    }
  } catch {
    // keep body_prefix fallback
  }
  console.error("[whatsapp-webhook] outbound failed", meta);
}

async function postWhatsAppMessage(
  creds: WhatsAppCredentials,
  body: Record<string, unknown>,
): Promise<WhatsAppSendResult> {
  const url = `https://graph.facebook.com/v21.0/${creds.phoneNumberId}/messages`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WHATSAPP_OUTBOUND_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    console.error("[whatsapp-webhook] outbound fetch failed", {
      reason: isTimeout ? "timeout" : String(err),
    });
    return { ok: false, status: 0, error: isTimeout ? "send_timeout" : "send_fetch_failed" };
  }
  clearTimeout(timer);
  const raw = await response.text();
  if (!response.ok) {
    logGraphError(raw, response.status);
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

function welcomeInteractivePayload(
  toWaId: string,
  headerImageUrl: string | null,
): Record<string, unknown> {
  const bodyText = headerImageUrl
    ? WHATSAPP_WELCOME_CARD_BODY
    : WHATSAPP_WELCOME_INTERACTIVE_BODY;
  const interactive: Record<string, unknown> = {
    type: "button",
    body: { text: bodyText },
    action: { buttons: WHATSAPP_WELCOME_BUTTONS },
  };
  if (headerImageUrl) {
    interactive.header = {
      type: "image",
      image: { link: headerImageUrl },
    };
  }
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toWaId,
    type: "interactive",
    interactive,
  };
}

/**
 * Interactive tappable menu — image header + three reply buttons (SSOT customer UX).
 * One Graph call on the happy path. Image header fallback to buttons-only if Meta rejects media.
 */
export async function sendWhatsAppWelcomeMenu(
  creds: WhatsAppCredentials,
  toWaId: string,
): Promise<WhatsAppSendResult> {
  const imageUrl = readWhatsAppWelcomeHeaderImageUrl();
  if (imageUrl) {
    const withImage = await postWhatsAppMessage(
      creds,
      welcomeInteractivePayload(toWaId, imageUrl),
    );
    if (withImage.ok) return withImage;
  }

  return postWhatsAppMessage(creds, welcomeInteractivePayload(toWaId, null));
}
