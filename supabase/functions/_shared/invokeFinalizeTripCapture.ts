/**
 * Internal HTTP invoke of finalize-trip-and-capture with retry on transient edge failures.
 * BOOT_ERROR / 502 / 503 / 504 can occur during cold starts or deploy windows.
 */

export type InvokeFinalizeTripCaptureResult = {
  ok: boolean;
  error?: string;
  body?: Record<string, unknown>;
  httpStatus?: number;
  attempts?: number;
};

const RETRYABLE_HTTP_STATUSES = new Set([502, 503, 504]);
const RETRY_DELAYS_MS = [500, 1500, 3000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableFailure(status: number, body: Record<string, unknown>): boolean {
  if (RETRYABLE_HTTP_STATUSES.has(status)) return true;
  const code = String(body?.code ?? "").toUpperCase();
  return code === "BOOT_ERROR";
}

export async function invokeFinalizeTripCapture(args: {
  supabaseUrl: string;
  serviceRoleKey: string;
  tripId: string;
  tipPence?: number;
  source?: string;
  maxAttempts?: number;
}): Promise<InvokeFinalizeTripCaptureResult> {
  const {
    supabaseUrl,
    serviceRoleKey,
    tripId,
    tipPence = 0,
    source,
    maxAttempts = RETRY_DELAYS_MS.length + 1,
  } = args;

  let lastError = "unknown";
  let lastStatus = 0;
  let lastBody: Record<string, unknown> = {};

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/finalize-trip-and-capture`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        body: JSON.stringify({
          trip_id: tripId,
          tip_pence: tipPence,
          internal: true,
          ...(source ? { source } : {}),
        }),
      });

      const text = await res.text();
      let body: Record<string, unknown> = {};
      try {
        body = text ? JSON.parse(text) as Record<string, unknown> : {};
      } catch {
        body = { raw: text.slice(0, 500) };
      }

      lastStatus = res.status;
      lastBody = body;

      const businessOk = res.ok && !body?.error && body?.success !== false && body?.deferred !== true;
      if (businessOk) {
        return { ok: true, body, httpStatus: res.status, attempts: attempt };
      }

      const errMsg = typeof body?.error === "string"
        ? body.error
        : typeof body?.message === "string"
        ? body.message
        : `HTTP ${res.status}`;
      lastError = errMsg;

      if (attempt < maxAttempts && isRetryableFailure(res.status, body)) {
        console.warn("[PAYMENT_AUDIT] finalize_invoke_retry", {
          trip_id: tripId,
          attempt,
          http_status: res.status,
          code: body?.code ?? null,
          next_delay_ms: RETRY_DELAYS_MS[attempt - 1] ?? 3000,
          source: source ?? null,
        });
        await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 3000);
        continue;
      }

      return {
        ok: false,
        error: lastError,
        body,
        httpStatus: res.status,
        attempts: attempt,
      };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < maxAttempts) {
        console.warn("[PAYMENT_AUDIT] finalize_invoke_retry_network", {
          trip_id: tripId,
          attempt,
          error: lastError,
          next_delay_ms: RETRY_DELAYS_MS[attempt - 1] ?? 3000,
        });
        await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 3000);
        continue;
      }
      return { ok: false, error: lastError, attempts: attempt };
    }
  }

  return {
    ok: false,
    error: lastError,
    body: lastBody,
    httpStatus: lastStatus || undefined,
    attempts: maxAttempts,
  };
}
