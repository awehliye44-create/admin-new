/**
 * HMAC client for the ONECAB Revolut Business fixed-egress relay.
 * Secrets never leave Edge → relay; browser never sees them.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function hexFromBuffer(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return hexFromBuffer(digest);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return hexFromBuffer(sig);
}

/** Prefer HTTPS URL; accept legacy BASE_URL alias. */
function relayBaseFromEnv(): string {
  const enabled = (Deno.env.get("REVOLUT_BUSINESS_RELAY_ENABLED") ?? "true").trim().toLowerCase();
  if (enabled === "false" || enabled === "0" || enabled === "off") return "";
  return (
    Deno.env.get("REVOLUT_BUSINESS_RELAY_URL") ??
    Deno.env.get("REVOLUT_BUSINESS_RELAY_BASE_URL") ??
    ""
  ).trim().replace(/\/$/, "");
}

export function isRevolutBusinessRelayConfigured(): boolean {
  const base = relayBaseFromEnv();
  const secret = (Deno.env.get("REVOLUT_BUSINESS_RELAY_SHARED_SECRET") ?? "").trim();
  return Boolean(base && secret.length >= 32);
}

export function getRevolutBusinessRelayBaseUrl(): string | null {
  const base = relayBaseFromEnv();
  return base || null;
}

async function signedHeaders(args: {
  method: string;
  path: string;
  body: string;
  secret: string;
  idempotencyKey?: string;
}): Promise<Record<string, string>> {
  const ts = String(Date.now());
  const nonce = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const bodyHash = await sha256Hex(args.body);
  const message = `${args.method}\n${args.path}\n${ts}\n${nonce}\n${bodyHash}`;
  const signature = await hmacHex(args.secret, message);
  const headers: Record<string, string> = {
    "x-onecab-timestamp": ts,
    "x-onecab-nonce": nonce,
    "x-onecab-signature": signature,
    "x-onecab-client-id": "supabase-edge",
  };
  if (args.idempotencyKey) headers["idempotency-key"] = args.idempotencyKey;
  return headers;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 8_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message))) {
      throw new Error("revolut_business_relay_unreachable");
    }
    throw new Error("revolut_business_relay_unreachable");
  } finally {
    clearTimeout(timer);
  }
}

export async function relayRevolutTokenExchange(formBody: string): Promise<Response> {
  const base = getRevolutBusinessRelayBaseUrl();
  const secret = (Deno.env.get("REVOLUT_BUSINESS_RELAY_SHARED_SECRET") ?? "").trim();
  if (!base || !secret) throw new Error("revolut_business_relay_not_configured");
  const path = "/v1/revolut/auth/token";
  const headers = await signedHeaders({ method: "POST", path, body: formBody, secret });
  headers["Content-Type"] = "application/x-www-form-urlencoded";
  return fetchWithTimeout(`${base}${path}`, { method: "POST", headers, body: formBody });
}

export async function relayRevolutAccounts(accessToken: string): Promise<Response> {
  const base = getRevolutBusinessRelayBaseUrl();
  const secret = (Deno.env.get("REVOLUT_BUSINESS_RELAY_SHARED_SECRET") ?? "").trim();
  if (!base || !secret) throw new Error("revolut_business_relay_not_configured");
  const path = "/v1/revolut/accounts";
  const headers = await signedHeaders({ method: "GET", path, body: "", secret });
  headers["x-revolut-access-token"] = accessToken;
  return fetchWithTimeout(`${base}${path}`, { method: "GET", headers });
}

export async function relayRevolutAccount(accessToken: string, accountId: string): Promise<Response> {
  const base = getRevolutBusinessRelayBaseUrl();
  const secret = (Deno.env.get("REVOLUT_BUSINESS_RELAY_SHARED_SECRET") ?? "").trim();
  if (!base || !secret) throw new Error("revolut_business_relay_not_configured");
  const path = `/v1/revolut/accounts/${encodeURIComponent(accountId)}`;
  const headers = await signedHeaders({ method: "GET", path, body: "", secret });
  headers["x-revolut-access-token"] = accessToken;
  return fetchWithTimeout(`${base}${path}`, { method: "GET", headers });
}

/** Public relay liveness (no HMAC). */
export async function probeRelayPublicHealth(): Promise<{
  ok: boolean;
  mode: string | null;
  live_payout_execution_enabled: boolean | null;
}> {
  const base = getRevolutBusinessRelayBaseUrl();
  if (!base) {
    return { ok: false, mode: null, live_payout_execution_enabled: null };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    const res = await fetch(`${base}/health`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, mode: null, live_payout_execution_enabled: null };
    const json = await res.json().catch(() => ({}));
    return {
      ok: Boolean(json?.ok),
      mode: typeof json?.mode === "string" ? json.mode : null,
      live_payout_execution_enabled: typeof json?.live_payout_execution_enabled === "boolean"
        ? json.live_payout_execution_enabled
        : null,
    };
  } catch {
    return { ok: false, mode: null, live_payout_execution_enabled: null };
  }
}

export function assertRevolutBusinessRelayConfigured(): void {
  if (!isRevolutBusinessRelayConfigured()) {
    throw new Error("revolut_business_relay_not_configured");
  }
}

export async function relayEgressIpProbe(): Promise<{
  ipify: string | null;
  ifconfig: string | null;
  identical: boolean;
  whitelist_candidate: string | null;
}> {
  const base = getRevolutBusinessRelayBaseUrl();
  const secret = (Deno.env.get("REVOLUT_BUSINESS_RELAY_SHARED_SECRET") ?? "").trim();
  if (!base || !secret) throw new Error("revolut_business_relay_not_configured");
  const path = "/v1/egress-ip";
  const headers = await signedHeaders({ method: "GET", path, body: "", secret });
  const res = await fetch(`${base}${path}`, { method: "GET", headers });
  const json = await res.json();
  return {
    ipify: json?.outbound?.ipify ?? null,
    ifconfig: json?.outbound?.ifconfig ?? null,
    identical: Boolean(json?.outbound?.identical),
    whitelist_candidate: json?.whitelist_candidate ?? null,
  };
}

/** Slice 2 — list counterparties (discovery / match only). Never creates. */
export async function relayRevolutCounterparties(accessToken: string): Promise<Response> {
  const base = getRevolutBusinessRelayBaseUrl();
  const secret = (Deno.env.get("REVOLUT_BUSINESS_RELAY_SHARED_SECRET") ?? "").trim();
  if (!base || !secret) throw new Error("revolut_business_relay_not_configured");
  const path = "/v1/revolut/counterparties";
  const headers = await signedHeaders({ method: "GET", path, body: "", secret });
  headers["x-revolut-access-token"] = accessToken;
  return fetchWithTimeout(`${base}${path}`, { method: "GET", headers }, 15_000);
}

/** Slice 2 — create counterparty (+ nested recipient accounts). Never /pay. */
export async function relayRevolutCreateCounterparty(args: {
  accessToken: string;
  body: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<Response> {
  const base = getRevolutBusinessRelayBaseUrl();
  const secret = (Deno.env.get("REVOLUT_BUSINESS_RELAY_SHARED_SECRET") ?? "").trim();
  if (!base || !secret) throw new Error("revolut_business_relay_not_configured");
  const path = "/v1/revolut/counterparty";
  const raw = JSON.stringify(args.body);
  const headers = await signedHeaders({
    method: "POST",
    path,
    body: raw,
    secret,
    idempotencyKey: args.idempotencyKey,
  });
  headers["Content-Type"] = "application/json";
  headers["x-revolut-access-token"] = args.accessToken;
  return fetchWithTimeout(`${base}${path}`, { method: "POST", headers, body: raw }, 20_000);
}

/** Safety probe: POST /pay must remain blocked on the relay. */
export async function relayProbePayBlocked(): Promise<{ blocked: boolean; status: number; error: string | null }> {
  const base = getRevolutBusinessRelayBaseUrl();
  const secret = (Deno.env.get("REVOLUT_BUSINESS_RELAY_SHARED_SECRET") ?? "").trim();
  if (!base || !secret) return { blocked: true, status: 0, error: "relay_not_configured" };
  const path = "/v1/revolut/pay";
  const body = "{}";
  const headers = await signedHeaders({ method: "POST", path, body, secret });
  headers["Content-Type"] = "application/json";
  try {
    const res = await fetchWithTimeout(`${base}${path}`, { method: "POST", headers, body }, 5_000);
    const json = await res.json().catch(() => ({}));
    const err = typeof json?.error === "string" ? json.error : null;
    const blocked = res.status === 403 || err === "payments_disabled" || err === "operation_not_allowed";
    return { blocked, status: res.status, error: err };
  } catch {
    return { blocked: true, status: 0, error: "relay_unreachable" };
  }
}

/**
 * Approved driver-payout payment op (Slice 4 validate / Slice 7 submit).
 * Slice 7: pass accessToken when REVOLUT_PAYMENT_TRANSPORT_ENABLED=true and LIVE=false;
 * relay forwards validated body to Revolut POST /pay.
 */
export async function relayApprovedDriverPayoutPayment(args: {
  body: Record<string, unknown>;
  idempotencyKey: string;
  accessToken?: string;
  timeoutMs?: number;
}): Promise<{
  status: number;
  error: string | null;
  revolut_pay_called: boolean;
  provider_payment_id: string | null;
  provider_state: string | null;
  json: Record<string, unknown>;
}> {
  const base = getRevolutBusinessRelayBaseUrl();
  const secret = (Deno.env.get("REVOLUT_BUSINESS_RELAY_SHARED_SECRET") ?? "").trim();
  if (!base || !secret) {
    return {
      status: 0,
      error: "relay_not_configured",
      revolut_pay_called: false,
      provider_payment_id: null,
      provider_state: null,
      json: {},
    };
  }
  const path = "/v1/revolut/driver-payout-payment";
  const raw = JSON.stringify(args.body);
  const headers = await signedHeaders({
    method: "POST",
    path,
    body: raw,
    secret,
    idempotencyKey: args.idempotencyKey,
  });
  headers["Content-Type"] = "application/json";
  if (args.accessToken) headers["x-revolut-access-token"] = args.accessToken;
  try {
    const res = await fetchWithTimeout(
      `${base}${path}`,
      { method: "POST", headers, body: raw },
      args.timeoutMs ?? 10_000,
    );
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    const err = typeof json?.error === "string"
      ? json.error
      : (typeof json?.code === "string" ? json.code : null);
    const providerPaymentId = typeof json?.provider_payment_id === "string"
      ? json.provider_payment_id
      : (typeof json?.id === "string" ? json.id : null);
    const providerState = typeof json?.provider_state === "string"
      ? json.provider_state
      : (typeof json?.state === "string" ? json.state : null);
    return {
      status: res.status,
      error: err,
      revolut_pay_called: json?.revolut_pay_called === true,
      provider_payment_id: providerPaymentId,
      provider_state: providerState,
      json,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "relay_unreachable";
    const timedOut = /abort|timeout|unreachable/i.test(msg);
    return {
      status: 0,
      error: timedOut ? "relay_timeout" : "relay_unreachable",
      revolut_pay_called: Boolean(args.accessToken),
      provider_payment_id: null,
      provider_state: null,
      json: {},
    };
  }
}

/**
 * Slice 8 read-only payment status: POST relay → Revolut GET /transaction/:id.
 * Never calls /pay. Never forges completed — returns provider state as-is.
 */
export async function relayApprovedDriverPayoutPaymentStatus(args: {
  providerPaymentId: string;
  payoutItemId?: string;
  accessToken: string;
  timeoutMs?: number;
}): Promise<{
  status: number;
  error: string | null;
  revolut_pay_called: false;
  provider_payment_id: string | null;
  provider_state: string | null;
  completed_at: string | null;
  created_at: string | null;
  json: Record<string, unknown>;
}> {
  const base = getRevolutBusinessRelayBaseUrl();
  const secret = (Deno.env.get("REVOLUT_BUSINESS_RELAY_SHARED_SECRET") ?? "").trim();
  if (!base || !secret) {
    return {
      status: 0,
      error: "relay_not_configured",
      revolut_pay_called: false,
      provider_payment_id: null,
      provider_state: null,
      completed_at: null,
      created_at: null,
      json: {},
    };
  }
  const path = "/v1/revolut/driver-payout-payment-status";
  const bodyObj: Record<string, unknown> = {
    provider_payment_id: args.providerPaymentId,
  };
  if (args.payoutItemId) bodyObj.payout_item_id = args.payoutItemId;
  const raw = JSON.stringify(bodyObj);
  const headers = await signedHeaders({
    method: "POST",
    path,
    body: raw,
    secret,
    idempotencyKey: `status:${args.providerPaymentId}`,
  });
  headers["Content-Type"] = "application/json";
  headers["x-revolut-access-token"] = args.accessToken;
  try {
    const res = await fetchWithTimeout(
      `${base}${path}`,
      { method: "POST", headers, body: raw },
      args.timeoutMs ?? 15_000,
    );
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    const err = typeof json?.error === "string"
      ? json.error
      : (typeof json?.code === "string" ? json.code : null);
    const providerPaymentId = typeof json?.provider_payment_id === "string"
      ? json.provider_payment_id
      : (typeof json?.id === "string" ? json.id : args.providerPaymentId);
    const providerState = typeof json?.provider_state === "string"
      ? json.provider_state
      : (typeof json?.state === "string" ? json.state : null);
    const completedAt = typeof json?.completed_at === "string" ? json.completed_at : null;
    const createdAt = typeof json?.created_at === "string" ? json.created_at : null;
    return {
      status: res.status,
      error: err,
      revolut_pay_called: false,
      provider_payment_id: providerPaymentId,
      provider_state: providerState,
      completed_at: completedAt,
      created_at: createdAt,
      json,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "relay_unreachable";
    const timedOut = /abort|timeout|unreachable/i.test(msg);
    return {
      status: 0,
      error: timedOut ? "relay_timeout" : "relay_unreachable",
      revolut_pay_called: false,
      provider_payment_id: args.providerPaymentId,
      provider_state: null,
      completed_at: null,
      created_at: null,
      json: {},
    };
  }
}

// silence unused in typecheck contexts
void timingSafeEqual;
