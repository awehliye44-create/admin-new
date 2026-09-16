/**
 * Lock: admin-payment-sessions keeps truthful HTTP statuses.
 * Must not coerce auth/validation/provider/server errors to HTTP 200.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  AdminPaymentSessionsInputSchema,
  gateFailureJsonResponse,
  handleAdminPaymentSessions,
  type AdminPaymentSessionsHandlerDeps,
} from "../admin-payment-sessions/handler.ts";
import type { GateError, GateResult } from "./adminPaymentGate.ts";

function jsonGate(status: number, body: Record<string, unknown>): GateError {
  return {
    ok: false,
    response: new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  };
}

function mockOkGate(): GateResult {
  return {
    ok: true,
    supabase: {} as GateResult["supabase"],
    userId: "admin-user",
  };
}

function baseDeps(
  overrides: Partial<AdminPaymentSessionsHandlerDeps> = {},
): AdminPaymentSessionsHandlerDeps {
  return {
    requireAuth: async () => mockOkGate(),
    listSessions: async () => ({
      success: true,
      tab: "captured",
      rows: [{ payment_session_id: "ps-1" }],
      summary: { total: 1 },
      filtered_total: 1,
      has_more: false,
    }) as never,
    resolveScope: async () => ({
      ok: true as const,
      allowedServiceAreaIds: ["sa-1"],
      financial_model: "PLATFORM_COLLECTED",
    }) as never,
    inspectProviderOrder: async () => ({ id: "ord_1", state: "COMPLETED" }),
    ...overrides,
  };
}

async function post(body: unknown, deps?: AdminPaymentSessionsHandlerDeps): Promise<Response> {
  return handleAdminPaymentSessions(
    new Request("http://local/admin-payment-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    deps ?? baseDeps(),
  );
}

Deno.test("unauthenticated request returns 401, not 200", async () => {
  const res = await post({}, baseDeps({
    requireAuth: async () => jsonGate(401, { error: "Unauthorized" }),
  }));
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.success, false);
  assertEquals(typeof body.error, "string");
});

Deno.test("forbidden role returns 403, not 200", async () => {
  const res = await post({}, baseDeps({
    requireAuth: async () => jsonGate(403, {
      error: "Forbidden — admin or staff access required",
    }),
  }));
  assertEquals(res.status, 403);
  const body = await res.json();
  assertEquals(body.success, false);
  assertStringIncludes(String(body.error), "Forbidden");
});

Deno.test("invalid tab/filter returns 400", async () => {
  const res = await post({ tab: "not_a_real_tab" });
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.success, false);
  assertEquals(body.error, "Invalid input");
  assertEquals(typeof body.details, "object");
});

Deno.test("list success returns 200 with structured JSON", async () => {
  const res = await post({ tab: "captured", service_area_id: "11111111-1111-1111-1111-111111111111" });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.success, true);
  assertEquals(Array.isArray(body.rows), true);
});

Deno.test("inspect provider upstream failure returns 502, not 200", async () => {
  const res = await post(
    { inspect_provider_order_id: "ord_fail" },
    baseDeps({
      inspectProviderOrder: async () => {
        throw new Error("upstream Revolut timeout");
      },
    }),
  );
  assertEquals(res.status, 502);
  const body = await res.json();
  assertEquals(body.success, false);
  assertStringIncludes(String(body.error), "upstream");
  assertEquals(typeof body.provider_verification_message, "string");
});

Deno.test("omitted tab defaults to captured", () => {
  const parsed = AdminPaymentSessionsInputSchema.safeParse({});
  assertEquals(parsed.success, true);
  if (parsed.success) assertEquals(parsed.data.tab, "captured");
});

Deno.test("tab recovery maps to failed_recovery", () => {
  const parsed = AdminPaymentSessionsInputSchema.safeParse({ tab: "recovery" });
  assertEquals(parsed.success, true);
  if (parsed.success) assertEquals(parsed.data.tab, "failed_recovery");
});

Deno.test("gateFailureJsonResponse preserves status and structured body", async () => {
  const res = await gateFailureJsonResponse(
    jsonGate(401, { error: "Unauthorized", code: "NO_AUTH" }),
  );
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.success, false);
  assertEquals(body.error, "Unauthorized");
  assertEquals(body.code, "NO_AUTH");
});

Deno.test("list response must not emit driver_credit_* fields", async () => {
  const res = await post({ tab: "captured" }, baseDeps({
    listSessions: async () => ({
      success: true,
      tab: "captured",
      rows: [{
        payment_session_id: "ps-1",
        provider_state: "COMPLETED",
        captured_amount_pence: 400,
        // poisoned keys must not be added by handler — assert response keys
      }],
      summary: { total: 1 },
    }) as never,
  }));
  assertEquals(res.status, 200);
  const body = await res.json();
  const row = body.rows[0] as Record<string, unknown>;
  const rowKeys = Object.keys(row);
  const creditKeys = rowKeys.filter((k) => k.includes("driver_credit"));
  assertEquals(creditKeys, []);
  const summaryKeys = Object.keys(body.summary ?? {});
  assertEquals(summaryKeys.filter((k) => k.includes("driver_credit")), []);
});

Deno.test("source lock: no financeSafeJson always-200 coercer", async () => {
  const indexSrc = await Deno.readTextFile(
    new URL("../admin-payment-sessions/index.ts", import.meta.url),
  );
  const handlerSrc = await Deno.readTextFile(
    new URL("../admin-payment-sessions/handler.ts", import.meta.url),
  );
  assertEquals(indexSrc.includes("financeSafeJson"), false);
  assertEquals(handlerSrc.includes("financeSafeJson"), false);
  assertEquals(/jsonResponse\(\s*[^,]+,\s*200\s*\)/.test(handlerSrc), false);
  assertStringIncludes(handlerSrc, "jsonResponse(");
  // gate path uses gate.response.status — auth failures keep truthful codes
  assertStringIncludes(handlerSrc, "gate.response.status");
  assertEquals(/,\s*400\s*[,)]/.test(handlerSrc), true);
  assertEquals(/,\s*502\s*[,)]/.test(handlerSrc), true);
  assertEquals(/,\s*500\s*[,)]/.test(handlerSrc), true);
  // ownership: no wallet ledger reads in wrapper
  assertEquals(handlerSrc.includes("driver_wallet_ledger"), false);
  assertEquals(handlerSrc.includes("enrichPaymentSessionsWithDriverCredit"), false);
});
