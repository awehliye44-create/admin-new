/**
 * Revolut Merchant API webhook management (API-managed — not Business dashboard).
 * @see https://developer.revolut.com/docs/merchant/create-webhook
 */

import {
  normalizeRevolutMerchantSecret,
  revolutMerchantRequest,
} from "./revolutApi.ts";
import type { ProviderEnvironment } from "./paymentProviders/types.ts";

export const REVOLUT_MERCHANT_WEBHOOK_API_VERSION = "2026-04-20";

/** Payment lifecycle + payout events ONECAB subscribes to. */
export const ONECAB_REVOLUT_WEBHOOK_EVENTS = [
  "ORDER_AUTHORISED",
  "ORDER_COMPLETED",
  "ORDER_CANCELLED",
  "ORDER_FAILED",
  "ORDER_PAYMENT_FAILED",
  "ORDER_PAYMENT_DECLINED",
  "ORDER_PAYMENT_AUTHENTICATED",
  "PAYOUT_INITIATED",
  "PAYOUT_COMPLETED",
  "PAYOUT_FAILED",
] as const;

export type RevolutWebhookEventType = typeof ONECAB_REVOLUT_WEBHOOK_EVENTS[number];

export type RevolutWebhookRegistration = {
  id: string;
  url: string;
  events: string[];
  signing_secret?: string;
};

export function resolveOnecabRevolutWebhookUrl(supabaseUrl?: string | null): string {
  const base = (supabaseUrl ?? Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
  if (!base) {
    throw new Error("SUPABASE_URL is required to resolve the revolut-webhook endpoint URL");
  }
  return `${base}/functions/v1/revolut-webhook`;
}

export async function listRevolutWebhooks(args: {
  environment: ProviderEnvironment;
  secretKey: string;
}): Promise<RevolutWebhookRegistration[]> {
  const data = await revolutMerchantRequest<RevolutWebhookRegistration[] | { webhooks?: RevolutWebhookRegistration[] }>(
    args.environment,
    normalizeRevolutMerchantSecret(args.secretKey),
    "/webhooks",
    { method: "GET" },
    REVOLUT_MERCHANT_WEBHOOK_API_VERSION,
  );
  if (Array.isArray(data)) return data;
  return data.webhooks ?? [];
}

export async function getRevolutWebhook(args: {
  environment: ProviderEnvironment;
  secretKey: string;
  webhookId: string;
}): Promise<RevolutWebhookRegistration> {
  return await revolutMerchantRequest<RevolutWebhookRegistration>(
    args.environment,
    normalizeRevolutMerchantSecret(args.secretKey),
    `/webhooks/${encodeURIComponent(args.webhookId)}`,
    { method: "GET" },
    REVOLUT_MERCHANT_WEBHOOK_API_VERSION,
  );
}

export async function createRevolutWebhook(args: {
  environment: ProviderEnvironment;
  secretKey: string;
  url: string;
  events?: readonly string[];
}): Promise<RevolutWebhookRegistration> {
  return await revolutMerchantRequest<RevolutWebhookRegistration>(
    args.environment,
    normalizeRevolutMerchantSecret(args.secretKey),
    "/webhooks",
    {
      method: "POST",
      body: JSON.stringify({
        url: args.url,
        events: [...(args.events ?? ONECAB_REVOLUT_WEBHOOK_EVENTS)],
      }),
    },
    REVOLUT_MERCHANT_WEBHOOK_API_VERSION,
  );
}

export async function updateRevolutWebhook(args: {
  environment: ProviderEnvironment;
  secretKey: string;
  webhookId: string;
  url?: string;
  events?: readonly string[];
}): Promise<RevolutWebhookRegistration> {
  const body: Record<string, unknown> = {};
  if (args.url) body.url = args.url;
  if (args.events) body.events = [...args.events];
  return await revolutMerchantRequest<RevolutWebhookRegistration>(
    args.environment,
    normalizeRevolutMerchantSecret(args.secretKey),
    `/webhooks/${encodeURIComponent(args.webhookId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
    },
    REVOLUT_MERCHANT_WEBHOOK_API_VERSION,
  );
}

export async function ensureOnecabRevolutWebhook(args: {
  environment: ProviderEnvironment;
  secretKey: string;
  webhookUrl: string;
  existingWebhookId?: string | null;
}): Promise<{
  webhook: RevolutWebhookRegistration;
  created: boolean;
  updated: boolean;
}> {
  const targetEvents = [...ONECAB_REVOLUT_WEBHOOK_EVENTS];
  const normalizedUrl = args.webhookUrl.trim();

  if (args.existingWebhookId) {
    try {
      const current = await getRevolutWebhook({
        environment: args.environment,
        secretKey: args.secretKey,
        webhookId: args.existingWebhookId,
      });
      const eventsMatch = targetEvents.every((e) => current.events.includes(e))
        && current.events.length === targetEvents.length;
      const urlMatch = current.url === normalizedUrl;
      if (eventsMatch && urlMatch) {
        return { webhook: current, created: false, updated: false };
      }
      const updated = await updateRevolutWebhook({
        environment: args.environment,
        secretKey: args.secretKey,
        webhookId: args.existingWebhookId,
        url: normalizedUrl,
        events: targetEvents,
      });
      return { webhook: updated, created: false, updated: true };
    } catch {
      // fall through — recreate below
    }
  }

  const existing = await listRevolutWebhooks({
    environment: args.environment,
    secretKey: args.secretKey,
  });
  const match = existing.find((w) => w.url === normalizedUrl);
  if (match?.id) {
    const eventsMatch = targetEvents.every((e) => match.events.includes(e))
      && match.events.length === targetEvents.length;
    if (!eventsMatch || match.url !== normalizedUrl) {
      const updated = await updateRevolutWebhook({
        environment: args.environment,
        secretKey: args.secretKey,
        webhookId: match.id,
        url: normalizedUrl,
        events: targetEvents,
      });
      return { webhook: updated, created: false, updated: true };
    }
    const withSecret = await getRevolutWebhook({
      environment: args.environment,
      secretKey: args.secretKey,
      webhookId: match.id,
    });
    return { webhook: withSecret, created: false, updated: false };
  }

  const created = await createRevolutWebhook({
    environment: args.environment,
    secretKey: args.secretKey,
    url: normalizedUrl,
    events: targetEvents,
  });
  return { webhook: created, created: true, updated: false };
}
