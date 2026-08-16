/**
 * ONECAB Assistant — central, platform-neutral request handler.
 *
 * Runtime-free core so it can be unit-tested outside Deno. All I/O (env, fetch,
 * database) is injected. The AI provider is the OFFICIAL OpenAI Responses API
 * (https://api.openai.com/v1/responses) using the ONECAB-owned OPENAI_API_KEY
 * Edge Function secret. No AI gateway is involved.
 */

import {
  asksForPrivateData,
  buildSystemPrompt,
  containsSensitiveData,
  EMERGENCY_NOTICE,
  INJECTION_REPLY,
  isEmergency,
  isPromptInjection,
  matchFaq,
  NO_CONFIRMED_ANSWER,
  PRIVATE_DATA_REPLY,
  redact,
  selectTopics,
  SENSITIVE_WARNING,
  trimToWords,
  type QuickAction,
} from "./knowledge.ts";

/* ── platforms ────────────────────────────────────────────────────────────── */

export const SUPPORTED_PLATFORMS = ["website", "customer_app", "driver_app", "corporate_portal"] as const;
export type Platform = (typeof SUPPORTED_PLATFORMS)[number];
/** Phase 1: only the public website policy is implemented. */
export const ENABLED_PLATFORMS: Platform[] = ["website"];

/* ── origins ──────────────────────────────────────────────────────────────── */

const ALLOWED_ORIGINS = [
  "https://onecab.net",
  "https://www.onecab.net",
  "https://onecab-premium-ride.lovable.app",
];
const ALLOWED_ORIGIN_SUFFIXES = [".lovable.app", ".lovableproject.com"];

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    if (ALLOWED_ORIGINS.includes(origin)) return true;
    if (host === "localhost" || host === "127.0.0.1") return true;
    return ALLOWED_ORIGIN_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

export const corsHeaders = (origin: string | null) => ({
  "Access-Control-Allow-Origin": isAllowedOrigin(origin) ? (origin as string) : "https://onecab.net",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  Vary: "Origin",
});

/* ── server-side configuration ────────────────────────────────────────────── */

export const DEFAULT_CONFIG = {
  enabled: true,
  model: "gpt-5.6-luna",
  monthly_budget_usd: 25,
  monthly_warning_usd: 20,
  max_questions_per_session: 10,
  max_questions_per_ip_hour: 30,
  max_input_characters: 500,
  max_output_tokens: 400,
  max_output_words: 150,
  request_timeout_ms: 20000,
};
export type AssistantConfig = typeof DEFAULT_CONFIG;

/** Models the server is allowed to call. The client can never choose a model. */
export const ALLOWED_MODELS = ["gpt-5.6-luna"] as const;

/**
 * Server-side pricing (USD per 1M tokens), versioned so cost rows stay auditable.
 *
 * Source: OpenAI official pricing page, "Text tokens" table, tier = Standard
 * (default processing; this service never sends `service_tier`, so Fast-mode /
 * Batch / Flex rates do not apply). gpt-5.6-luna has a single context tier —
 * no short/long-context split. Calls go to the global https://api.openai.com
 * endpoint, so the 10% regional-processing (data-residency) uplift does NOT apply.
 * Cache writes are listed for completeness; this service sends no cache writes.
 */
export const PRICING_VERSION = "2026-08-16-openai-standard";
export const PRICING: Record<
  string,
  { input: number; cached_input: number; cache_write: number; output: number }
> = {
  "gpt-5.6-luna": { input: 0.2, cached_input: 0.02, cache_write: 0.25, output: 1.2 },
};


export function estimateCostUsd(
  model: string,
  usage: { input: number; cachedInput: number; output: number },
): number {
  const p = PRICING[model] ?? PRICING["gpt-5.6-luna"];
  const uncachedInput = Math.max(0, usage.input - usage.cachedInput);
  return (
    (uncachedInput / 1e6) * p.input +
    (usage.cachedInput / 1e6) * p.cached_input +
    (usage.output / 1e6) * p.output
  );
}

export function validateConfig(raw: Partial<AssistantConfig> | null): AssistantConfig | null {
  const c = { ...DEFAULT_CONFIG, ...(raw ?? {}) } as AssistantConfig;
  const positive = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0;
  if (typeof c.enabled !== "boolean") return null;
  if (!ALLOWED_MODELS.includes(c.model as (typeof ALLOWED_MODELS)[number])) return null;
  if (!positive(c.monthly_budget_usd)) return null;
  if (!positive(c.max_questions_per_session) || !positive(c.max_questions_per_ip_hour)) return null;
  if (!positive(c.max_input_characters) || !positive(c.max_output_tokens)) return null;
  if (!positive(c.max_output_words) || !positive(c.request_timeout_ms)) return null;
  return c;
}

/* ── injected dependencies ────────────────────────────────────────────────── */

export type Outcome =
  | "ai"
  | "faq_cache"
  | "blocked_injection"
  | "blocked_private_data"
  | "sensitive_input"
  | "emergency"
  | "rate_limited_session"
  | "rate_limited_ip"
  | "budget_reached"
  | "disabled"
  | "invalid_request"
  | "misconfigured"
  | "ai_error";

export interface EventRow {
  session_ref: string;
  ip_hash: string;
  platform: Platform;
  outcome: Outcome;
  success: boolean;
  quick_action: string | null;
  model: string | null;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  pricing_version: string | null;
  safety_outcome: string | null;
  rate_limit_outcome: string | null;
}

export interface AssistantDb {
  loadConfig(platform: Platform): Promise<Partial<AssistantConfig> | null>;
  /** Atomic: increments and rejects in one statement so parallel calls cannot bypass. */
  consumeQuota(args: {
    sessionHash: string;
    ipHash: string;
    platform: Platform;
    sessionLimit: number;
    ipHourLimit: number;
  }): Promise<{ allowed: boolean; reason: "session" | "ip" | null }>;
  logEvent(row: EventRow): Promise<void>;
  usage(): Promise<{ day_usd: number; month_usd: number }>;
}

export interface AssistantDeps {
  env: (key: string) => string | undefined;
  fetch: typeof fetch;
  db: AssistantDb;
}

/* ── session tokens (server-issued, HMAC-signed) ──────────────────────────── */

const enc = new TextEncoder();
const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(value)));
}

export async function issueSessionToken(secret: string): Promise<string> {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const id = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const issued = Date.now().toString(36);
  const sig = (await hmac(secret, `${id}.${issued}`)).slice(0, 32);
  return `${id}.${issued}.${sig}`;
}

export async function verifySessionToken(secret: string, token: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [id, issued, sig] = parts;
  if (!/^[0-9a-f]{32}$/.test(id) || !/^[0-9a-z]{1,12}$/.test(issued)) return null;
  const expected = (await hmac(secret, `${id}.${issued}`)).slice(0, 32);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  const age = Date.now() - parseInt(issued, 36);
  if (!Number.isFinite(age) || age < -60_000 || age > 24 * 3600_000) return null;
  return id;
}

/** Salted, hourly-bucketed hash. Plaintext IPs are never stored or logged. */
export async function hashIp(secret: string, ip: string): Promise<string> {
  const bucket = new Date().toISOString().slice(0, 13);
  return (await hmac(secret, `ip:${bucket}:${ip}`)).slice(0, 32);
}

/**
 * Trusted client IP.
 *
 * Supabase Edge Functions sit behind the platform's own proxy, which REPLACES
 * `x-forwarded-for` with the real peer address (the left-most entry) before the
 * function is invoked. We therefore read the left-most entry of the platform
 * header only, and never a customer-supplied `x-real-ip` / `forwarded` value.
 */
export function clientIp(headers: Headers): string {
  const raw = headers.get("x-forwarded-for") ?? "";
  const first = raw.split(",")[0]?.trim() ?? "";
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/;
  const ipv6 = /^[0-9a-fA-F:]{3,45}$/;
  if (ipv4.test(first) || ipv6.test(first)) return first;
  return "unknown";
}

/* ── OpenAI Responses call ────────────────────────────────────────────────── */

export interface AiResult {
  ok: boolean;
  text: string;
  usage: { input: number; cachedInput: number; output: number };
  errorKind?: "timeout" | "busy" | "unavailable" | "malformed";
}

export async function callOpenAi(
  deps: AssistantDeps,
  args: { apiKey: string; model: string; instructions: string; message: string; maxOutputTokens: number; timeoutMs: number },
): Promise<AiResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const empty = { input: 0, cachedInput: 0, output: 0 };
  try {
    const res = await deps.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: args.model,
        instructions: args.instructions,
        input: [{ role: "user", content: [{ type: "input_text", text: args.message }] }],
        max_output_tokens: args.maxOutputTokens,
        store: false,
        tools: [],
        tool_choice: "none",
        stream: false,
      }),
    });

    if (!res.ok) {
      return { ok: false, text: "", usage: empty, errorKind: res.status === 429 ? "busy" : "unavailable" };
    }

    let data: Record<string, any>;
    try {
      data = await res.json();
    } catch {
      return { ok: false, text: "", usage: empty, errorKind: "malformed" };
    }

    const text =
      typeof data?.output_text === "string" && data.output_text.trim()
        ? data.output_text
        : Array.isArray(data?.output)
          ? data.output
              .flatMap((o: any) => o?.content ?? [])
              .filter((c: any) => c?.type === "output_text" && typeof c?.text === "string")
              .map((c: any) => c.text)
              .join("")
          : "";

    if (!text || typeof text !== "string" || !text.trim()) {
      return { ok: false, text: "", usage: empty, errorKind: "malformed" };
    }

    const u = data?.usage ?? {};
    return {
      ok: true,
      text,
      usage: {
        input: Number(u.input_tokens ?? 0) || 0,
        cachedInput: Number(u.input_tokens_details?.cached_tokens ?? 0) || 0,
        output: Number(u.output_tokens ?? 0) || 0,
      },
    };
  } catch (error) {
    const aborted = (error as { name?: string })?.name === "AbortError";
    return { ok: false, text: "", usage: empty, errorKind: aborted ? "timeout" : "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

/* ── request handling ─────────────────────────────────────────────────────── */

const jsonResponse = (body: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });

export function createHandler(deps: AssistantDeps) {
  return async function handle(req: Request): Promise<Response> {
    const origin = req.headers.get("origin");
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, origin);
    if (!isAllowedOrigin(origin)) return jsonResponse({ error: "Origin not allowed" }, 403, origin);

    const sessionSecret = deps.env("ONECAB_ASSISTANT_SESSION_SECRET") ?? deps.env("SUPABASE_SERVICE_ROLE_KEY");
    const apiKey = deps.env("OPENAI_API_KEY");
    if (!sessionSecret) {
      return jsonResponse({ error: "assistant_unconfigured", reply: null, handoff: true }, 503, origin);
    }

    let payload: Record<string, unknown>;
    try {
      payload = (await req.json()) as Record<string, unknown>;
    } catch {
      return jsonResponse({ error: "Invalid request" }, 400, origin);
    }

    const platformRaw = String(payload.platform ?? "");
    const action = String(payload.action ?? "ask");

    if (!SUPPORTED_PLATFORMS.includes(platformRaw as Platform)) {
      return jsonResponse({ error: "Unsupported platform" }, 400, origin);
    }
    const platform = platformRaw as Platform;
    if (!ENABLED_PLATFORMS.includes(platform)) {
      return jsonResponse({ error: "Platform not enabled" }, 403, origin);
    }

    /* Session issue: the ONLY way to obtain a usable session reference. */
    if (action === "session") {
      return jsonResponse({ sessionToken: await issueSessionToken(sessionSecret) }, 200, origin);
    }
    if (action !== "ask") return jsonResponse({ error: "Invalid request" }, 400, origin);

    const token = typeof payload.sessionToken === "string" ? payload.sessionToken : "";
    const sessionId = await verifySessionToken(sessionSecret, token);
    if (!sessionId) return jsonResponse({ error: "invalid_session" }, 401, origin);

    const rawMessage = typeof payload.message === "string" ? payload.message : "";
    const quickActionRaw = payload.quickAction;
    const quickAction = (typeof quickActionRaw === "string" ? quickActionRaw.slice(0, 32) : null) as QuickAction | null;
    const honeypot = typeof payload.company_website === "string" ? payload.company_website : "";

    const ip = clientIp(req.headers);
    const ipHash = await hashIp(sessionSecret, ip);
    const sessionHash = (await hmac(sessionSecret, `session:${sessionId}`)).slice(0, 32);

    const log = (outcome: Outcome, extra: Partial<EventRow> = {}) =>
      deps.db
        .logEvent({
          session_ref: sessionHash,
          ip_hash: ipHash,
          platform,
          outcome,
          success: extra.success ?? true,
          quick_action: quickAction,
          model: null,
          input_tokens: 0,
          cached_input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
          pricing_version: null,
          safety_outcome: null,
          rate_limit_outcome: null,
          ...extra,
        })
        .catch(() => undefined);

    if (honeypot) return jsonResponse({ error: "Invalid request" }, 400, origin);

    let rawConfig: Partial<AssistantConfig> | null | undefined;
    try {
      rawConfig = await deps.db.loadConfig(platform);
    } catch {
      rawConfig = undefined;
    }
    const config = rawConfig === undefined ? null : validateConfig(rawConfig);
    if (!config) {
      await log("misconfigured", { success: false });
      return jsonResponse({ error: "assistant_unconfigured", reply: null, handoff: true }, 503, origin);
    }

    if (!rawMessage.trim() || rawMessage.length > config.max_input_characters) {
      await log("invalid_request", { success: false });
      return jsonResponse(
        { error: `Please keep your question under ${config.max_input_characters} characters.` },
        400,
        origin,
      );
    }
    const message = rawMessage.trim();

    if (!config.enabled) {
      await log("disabled");
      return jsonResponse({ reply: null, disabled: true, handoff: true }, 200, origin);
    }

    /* ── safety gates (no AI call, no message content stored) ───────────── */
    if (isEmergency(message)) {
      await log("emergency", { safety_outcome: "emergency" });
      return jsonResponse({ reply: EMERGENCY_NOTICE, handoff: true, source: "safety" }, 200, origin);
    }
    if (containsSensitiveData(message)) {
      await log("sensitive_input", { safety_outcome: "sensitive_input" });
      return jsonResponse({ reply: SENSITIVE_WARNING, source: "safety" }, 200, origin);
    }
    if (isPromptInjection(message)) {
      await log("blocked_injection", { safety_outcome: "injection" });
      return jsonResponse({ reply: INJECTION_REPLY, source: "safety" }, 200, origin);
    }
    if (asksForPrivateData(message)) {
      await log("blocked_private_data", { safety_outcome: "private_data" });
      return jsonResponse({ reply: PRIVATE_DATA_REPLY, handoff: true, source: "safety" }, 200, origin);
    }

    /* ── atomic rate limits (session + trusted IP) ─────────────────────── */
    let quota: { allowed: boolean; reason: "session" | "ip" | null };
    try {
      quota = await deps.db.consumeQuota({
        sessionHash,
        ipHash,
        platform,
        sessionLimit: config.max_questions_per_session,
        ipHourLimit: config.max_questions_per_ip_hour,
      });
    } catch {
      await log("misconfigured", { success: false });
      return jsonResponse({ error: "assistant_unavailable", reply: null, handoff: true }, 503, origin);
    }

    if (!quota.allowed && quota.reason === "session") {
      await log("rate_limited_session", { rate_limit_outcome: "session" });
      return jsonResponse(
        {
          reply:
            "We've reached the limit for this chat. ONECAB Support can carry on helping you by phone, WhatsApp or email.",
          handoff: true,
          limitReached: "session",
        },
        200,
        origin,
      );
    }
    if (!quota.allowed) {
      await log("rate_limited_ip", { rate_limit_outcome: "ip" });
      return jsonResponse(
        {
          reply:
            "There have been a lot of requests from your connection. Please try again later, or contact ONECAB Support.",
          handoff: true,
          limitReached: "ip",
        },
        429,
        origin,
      );
    }

    /* ── approved FAQ cache first (no AI cost) ─────────────────────────── */
    const faq = matchFaq(message, quickAction);
    if (faq) {
      await log("faq_cache", { rate_limit_outcome: "allowed" });
      return jsonResponse({ reply: faq.answer, source: "faq" }, 200, origin);
    }

    /* ── budget: monthly hard cap + kill switch ────────────────────────── */
    let usage: { day_usd: number; month_usd: number };
    try {
      usage = await deps.db.usage();
    } catch {
      await log("misconfigured", { success: false });
      return jsonResponse({ error: "assistant_unavailable", reply: null, handoff: true }, 503, origin);
    }
    if (usage.month_usd >= config.monthly_budget_usd) {
      await log("budget_reached");
      return jsonResponse(
        { reply: null, disabled: true, handoff: true, limitReached: "budget" },
        200,
        origin,
      );
    }

    if (!apiKey) {
      await log("misconfigured", { success: false });
      return jsonResponse({ error: "assistant_unconfigured", reply: null, handoff: true }, 503, origin);
    }

    const ai = await callOpenAi(deps, {
      apiKey,
      model: config.model,
      instructions: buildSystemPrompt(selectTopics(message), config.max_output_words),
      message: redact(message),
      maxOutputTokens: config.max_output_tokens,
      timeoutMs: config.request_timeout_ms,
    });

    if (!ai.ok) {
      await log("ai_error", { success: false, model: config.model });
      return jsonResponse(
        { reply: NO_CONFIRMED_ANSWER, handoff: true, error: ai.errorKind === "busy" ? "busy" : "unavailable" },
        200,
        origin,
      );
    }

    const reply = trimToWords(ai.text, config.max_output_words);
    const cost = estimateCostUsd(config.model, ai.usage);
    await log("ai", {
      model: config.model,
      input_tokens: ai.usage.input,
      cached_input_tokens: ai.usage.cachedInput,
      output_tokens: ai.usage.output,
      cost_usd: cost,
      pricing_version: PRICING_VERSION,
      rate_limit_outcome: "allowed",
      safety_outcome: "clean",
    });

    return jsonResponse({ reply, source: "ai", handoff: reply === NO_CONFIRMED_ANSWER }, 200, origin);
  };
}
