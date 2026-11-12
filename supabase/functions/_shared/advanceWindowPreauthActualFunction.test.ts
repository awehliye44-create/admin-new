/**
 * Actual createRevolutPreauthResponse execution — mocked Revolut + Supabase.
 * Proves order create → post-order session link succeeds with hoisted clocks
 * for Instant/Scheduled × card/apple_pay/google_pay (no ReferenceError).
 */
import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { createRevolutPreauthResponse } from "./revolutPreauth.ts";

type UpsertCapture = {
  providerOrderId: string | null | undefined;
  paymentMethod: string | null | undefined;
  advanceWindowValidatedAt: string | null | undefined;
  advanceWindowValidatedScheduledAt: string | null | undefined;
};

const SA = "11111111-1111-4111-8111-111111111111";
const VT = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const CUST = "44444444-4444-4444-8444-444444444444";

function loc(label: string) {
  return {
    lat: 52.04,
    lng: -0.76,
    address: `${label} Road`,
    place_id: `place_${label}`,
  };
}

function snapshot(args: {
  clientActionId: string;
  when: "NOW" | "SCHEDULED";
  scheduledAt: string | null;
  paymentMethod: string;
  createdAt: string;
}) {
  return {
    client_action_id: args.clientActionId,
    booking_draft_id: args.clientActionId,
    service_area_id: SA,
    vehicle_type_id: VT,
    customer_id: CUST,
    pickup: loc("pickup"),
    dropoff: loc("dropoff"),
    payment_method: args.paymentMethod,
    currency_code: "GBP",
    gross_fare_pence: 5300,
    final_estimated_fare_pence: 5300,
    estimated_fare: 53,
    canonical_fare_version: "v1",
    snapshot_version: 1,
    created_at: args.createdAt,
    when: args.when,
    scheduled_at: args.scheduledAt,
    passenger_name: "Test Rider",
    passenger_phone: "+447700900000",
    passenger_count: 1,
  };
}

function makeSupabase(captures: UpsertCapture[]): SupabaseClient {
  let sessionSeq = 0;
  const client = {
    from(table: string) {
      const state: Record<string, unknown> = { table, filters: [] as unknown[] };
      const api: Record<string, unknown> = {
        select(_cols?: string) {
          return api;
        },
        eq(_col: string, _val: unknown) {
          return api;
        },
        maybeSingle: async () => {
          if (table === "payment_sessions") {
            return { data: null, error: null };
          }
          if (table === "payment_authorization_ledger") {
            return { data: null, error: null };
          }
          if (table === "global_dispatch_settings") {
            return {
              data: {
                scheduled_rides_enabled: true,
                min_advance_time_minutes: 20,
                max_advance_days: 5,
                singleton: true,
              },
              error: null,
            };
          }
          if (table === "payment_provider_vault" || table === "provider_secrets") {
            return { data: null, error: null };
          }
          return { data: null, error: null };
        },
        single: async () => ({ data: null, error: null }),
        upsert(row: Record<string, unknown>, _opts?: unknown) {
          if (table === "payment_sessions") {
            captures.push({
              providerOrderId: row.provider_order_id as string | null | undefined,
              paymentMethod: row.payment_method as string | null | undefined,
              advanceWindowValidatedAt: row.advance_window_validated_at as
                | string
                | null
                | undefined,
              advanceWindowValidatedScheduledAt: row
                .advance_window_validated_scheduled_at as string | null | undefined,
            });
            sessionSeq += 1;
            const id = `sess_${sessionSeq}`;
            return {
              select() {
                return {
                  maybeSingle: async () => ({ data: { id }, error: null }),
                };
              },
            };
          }
          return {
            select() {
              return {
                maybeSingle: async () => ({ data: null, error: null }),
              };
            },
          };
        },
        insert() {
          return {
            select() {
              return {
                maybeSingle: async () => ({ data: null, error: null }),
              };
            },
          };
        },
      };
      void state;
      return api;
    },
  };
  return client as unknown as SupabaseClient;
}

const FROZEN_NOW_MS = Date.parse("2026-11-12T21:34:00.000Z");
const SCHEDULED_AT_ISO = new Date(FROZEN_NOW_MS + 45 * 60_000).toISOString(); // +45m > 20m min

const SCENARIOS: Array<{
  name: string;
  when: "NOW" | "SCHEDULED";
  paymentMethod: "card" | "apple_pay" | "google_pay";
  scheduledAt: string | null;
}> = [
  { name: "Instant Saved Card", when: "NOW", paymentMethod: "card", scheduledAt: null },
  { name: "Instant Apple Pay", when: "NOW", paymentMethod: "apple_pay", scheduledAt: null },
  { name: "Instant Google Pay", when: "NOW", paymentMethod: "google_pay", scheduledAt: null },
  {
    name: "Scheduled Saved Card",
    when: "SCHEDULED",
    paymentMethod: "card",
    scheduledAt: SCHEDULED_AT_ISO,
  },
  {
    name: "Scheduled Apple Pay",
    when: "SCHEDULED",
    paymentMethod: "apple_pay",
    scheduledAt: SCHEDULED_AT_ISO,
  },
  {
    name: "Scheduled Google Pay",
    when: "SCHEDULED",
    paymentMethod: "google_pay",
    scheduledAt: SCHEDULED_AT_ISO,
  },
];

Deno.test({
  name: "actual createRevolutPreauthResponse: six scenarios reach post-order session link",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    Deno.env.set("REVOLUT_MERCHANT_SECRET_KEY", "sk_test_advance_window_hotfix_mock");
    Deno.env.set("REVOLUT_PUBLIC_KEY", "pk_test_advance_window_hotfix_mock");

    const originalFetch = globalThis.fetch;
    let orderSeq = 0;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : (input as Request).url ?? input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/orders") && method === "POST" && !url.includes("/cancel")) {
        orderSeq += 1;
        const id = `ord_mock_${orderSeq}`;
        return new Response(
          JSON.stringify({
            id,
            state: "PENDING",
            token: `tok_${id}`,
            amount: 5300,
            currency: "GBP",
            public_id: `pub_${id}`,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/orders/") && method === "GET") {
        return new Response(
          JSON.stringify({ id: "ord_lookup", state: "PENDING", amount: 5300 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      for (const scenario of SCENARIOS) {
        const captures: UpsertCapture[] = [];
        const supabase = makeSupabase(captures);
        const clientActionId = crypto.randomUUID();
        const nowMs = FROZEN_NOW_MS;
        const realNow = Date.now;
        Date.now = () => nowMs;

        let response: Response;
        try {
          response = await createRevolutPreauthResponse({
            supabase,
            environment: "test",
            authorisedAmountPence: 5300,
            estimatedTotalPence: 5300,
            bufferPence: 0,
            paymentCurrency: "GBP",
            tripId: null,
            clientActionId,
            idempotencyKeySuffix: clientActionId,
            metadataExtra: { service_area_id: SA },
            paymentMethodType: scenario.paymentMethod,
            userId: USER,
            customerId: CUST,
            customerEmail: "rider@example.com",
            customerName: "Test Rider",
            // No platform PM → wallet/new-card return after session link (shared path).
            platformPaymentMethodId: null,
            bookingSnapshot: snapshot({
              clientActionId,
              when: scenario.when,
              scheduledAt: scenario.scheduledAt,
              paymentMethod: scenario.paymentMethod,
              createdAt: new Date(nowMs).toISOString(),
            }),
            fareSnapshot: { estimated_total_pence: 5300 },
            corsHeaders: { "Access-Control-Allow-Origin": "*" },
            logStep: () => {},
          });
        } finally {
          Date.now = realNow;
        }

        const bodyText = await response.text();
        assert(
          response.ok,
          `${scenario.name}: expected ok response, got ${response.status} ${bodyText.slice(0, 400)}`,
        );
        assertFalse(
          bodyText.includes("advanceWindowValidatedAt is not defined"),
          `${scenario.name}: ReferenceError leaked to client`,
        );
        assertFalse(
          bodyText.includes("is not defined"),
          `${scenario.name}: unexpected undefined ReferenceError: ${bodyText.slice(0, 200)}`,
        );

        const body = JSON.parse(bodyText) as Record<string, unknown>;
        const orderId = String(
          (body.order as { id?: string } | undefined)?.id
            ?? body.payment_intent_id
            ?? body.order_id
            ?? "",
        );
        assert(orderId.startsWith("ord_mock_"), `${scenario.name}: missing mocked order id`);

        const linked = captures.filter((c) => c.providerOrderId === orderId);
        assert(
          linked.length >= 1,
          `${scenario.name}: post-order session link missing (captures=${JSON.stringify(captures)})`,
        );
        const link = linked[linked.length - 1]!;
        assertEquals(link.paymentMethod, scenario.paymentMethod);

        if (scenario.when === "NOW") {
          // Instant must not require scheduled clocks (null → omitted from row).
          assertEquals(link.advanceWindowValidatedAt, undefined);
          assertEquals(link.advanceWindowValidatedScheduledAt, undefined);
        } else {
          assertEquals(typeof link.advanceWindowValidatedAt, "string");
          assert(String(link.advanceWindowValidatedAt).length > 0);
          assertEquals(link.advanceWindowValidatedScheduledAt, SCHEDULED_AT_ISO);
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});
