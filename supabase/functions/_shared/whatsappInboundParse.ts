/**
 * Parse inbound customer messages from Meta WhatsApp Cloud API webhook payloads.
 */

export type WhatsAppInboundMessage = {
  metaMessageId: string;
  waId: string;
  phoneNumberId: string | null;
  displayName: string | null;
  messageType: string;
  textBody: string | null;
  interactiveId: string | null;
  timestamp: string | null;
  /** The `value` block from the change that contained this message — stored as raw_payload per row. */
  valueBlock: Record<string, unknown>;
};

export type WhatsAppWebhookParseResult = {
  objectType: string | null;
  messages: WhatsAppInboundMessage[];
};

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readInteractiveId(message: Record<string, unknown>): string | null {
  const interactive = message.interactive;
  if (!interactive || typeof interactive !== "object") return null;
  const node = interactive as Record<string, unknown>;
  const button = node.button_reply;
  if (button && typeof button === "object") {
    return readString((button as Record<string, unknown>).id);
  }
  const list = node.list_reply;
  if (list && typeof list === "object") {
    return readString((list as Record<string, unknown>).id);
  }
  return null;
}

function readTextBody(message: Record<string, unknown>): string | null {
  const text = message.text;
  if (text && typeof text === "object") {
    return readString((text as Record<string, unknown>).body);
  }
  const button = message.button;
  if (button && typeof button === "object") {
    return readString((button as Record<string, unknown>).payload) ??
      readString((button as Record<string, unknown>).text);
  }
  return null;
}

/** Extract only inbound customer messages — ignore delivery/read/status echoes. */
export function parseWhatsAppWebhookPayload(payload: unknown): WhatsAppWebhookParseResult {
  const root = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};
  const objectType = readString(root.object);
  const messages: WhatsAppInboundMessage[] = [];

  const entries = Array.isArray(root.entry) ? root.entry : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const changes = Array.isArray((entry as Record<string, unknown>).changes)
      ? (entry as Record<string, unknown>).changes as unknown[]
      : [];
    for (const change of changes) {
      if (!change || typeof change !== "object") continue;
      const value = (change as Record<string, unknown>).value;
      if (!value || typeof value !== "object") continue;
      const valueNode = value as Record<string, unknown>;
      const metadata = valueNode.metadata && typeof valueNode.metadata === "object"
        ? valueNode.metadata as Record<string, unknown>
        : {};
      const phoneNumberId = readString(metadata.phone_number_id);

      const contacts = Array.isArray(valueNode.contacts) ? valueNode.contacts : [];
      const contactNameByWaId = new Map<string, string>();
      for (const contact of contacts) {
        if (!contact || typeof contact !== "object") continue;
        const waId = readString((contact as Record<string, unknown>).wa_id);
        const profile = (contact as Record<string, unknown>).profile;
        const name = profile && typeof profile === "object"
          ? readString((profile as Record<string, unknown>).name)
          : null;
        if (waId && name) contactNameByWaId.set(waId, name);
      }

      const inbound = Array.isArray(valueNode.messages) ? valueNode.messages : [];
      for (const rawMessage of inbound) {
        if (!rawMessage || typeof rawMessage !== "object") continue;
        const message = rawMessage as Record<string, unknown>;
        const metaMessageId = readString(message.id);
        const waId = readString(message.from);
        if (!metaMessageId || !waId) continue;
        messages.push({
          metaMessageId,
          waId,
          phoneNumberId,
          displayName: contactNameByWaId.get(waId) ?? null,
          messageType: readString(message.type) ?? "unknown",
          textBody: readTextBody(message),
          interactiveId: readInteractiveId(message),
          timestamp: readString(message.timestamp),
          valueBlock: valueNode,
        });
      }
    }
  }

  return { objectType, messages };
}
