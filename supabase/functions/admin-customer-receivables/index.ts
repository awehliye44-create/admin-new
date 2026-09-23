/**
 * Admin Customer Receivables — read-only list + event history.
 * Wraps admin_list_customer_receivables (finance ACL) with enrichment.
 * No Waive / no balance edit.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  requireAdminOrStaff,
  requirePageAccess,
  corsHeaders,
} from "../_shared/adminPaymentGate.ts";

const PAGE_SLUG = "financial-reconciliation";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isMissingRelation(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err ?? "");
  return (
    msg.includes("does not exist")
    || msg.includes("schema cache")
    || msg.includes("Could not find the function")
    || msg.includes("customer_receivable")
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const staffGate = await requireAdminOrStaff(req);
    if (!staffGate.ok) return staffGate.response;
    const gate = await requirePageAccess(staffGate, PAGE_SLUG);
    if (!gate.ok) return gate.response;

    const body = await req.json().catch(() => ({})) as {
      customer_id?: string | null;
      status?: string | null;
      limit?: number;
      include_events?: boolean;
    };

    const customerId = body.customer_id ? String(body.customer_id).trim() : null;
    const status = body.status ? String(body.status).trim().toUpperCase() : null;
    const limit = Math.min(500, Math.max(1, Math.round(Number(body.limit) || 100)));
    const includeEvents = body.include_events !== false;

    const { data: rpcRows, error: rpcErr } = await gate.supabase.rpc(
      "admin_list_customer_receivables",
      {
        p_customer_id: customerId,
        p_status: status,
        p_limit: limit,
      },
    );

    if (rpcErr) {
      if (isMissingRelation(rpcErr)) {
        return json({
          success: true,
          receivables: [],
          ledger_available: false,
          message:
            "Customer receivables ledger not applied yet (migration 20261127150000).",
        });
      }
      return json({ success: false, error: rpcErr.message }, 500);
    }

    const rows = (rpcRows ?? []) as Array<Record<string, unknown>>;
    const tripIds = [...new Set(rows.map((r) => String(r.source_trip_id ?? "")).filter(Boolean))];
    const customerIds = [...new Set(rows.map((r) => String(r.customer_id ?? "")).filter(Boolean))];
    const sessionIds = [
      ...new Set(
        rows
          .flatMap((r) => [
            String(r.reserved_payment_session_id ?? ""),
            String(r.source_payment_session_id ?? ""),
          ])
          .filter(Boolean),
      ),
    ];
    const receivableIds = rows.map((r) => String(r.id ?? "")).filter(Boolean);

    const tripsById = new Map<string, { trip_code: string | null }>();
    if (tripIds.length > 0) {
      const { data: trips } = await gate.supabase
        .from("trips")
        .select("id, trip_code")
        .in("id", tripIds);
      for (const t of trips ?? []) {
        tripsById.set(String(t.id), { trip_code: t.trip_code ? String(t.trip_code) : null });
      }
    }

    const customersById = new Map<string, { display_name: string | null; email: string | null }>();
    if (customerIds.length > 0) {
      const { data: customers } = await gate.supabase
        .from("customers")
        .select("id, first_name, last_name, email")
        .in("id", customerIds);
      for (const c of customers ?? []) {
        const name = [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || null;
        customersById.set(String(c.id), {
          display_name: name,
          email: c.email ? String(c.email) : null,
        });
      }
    }

    const sessionsById = new Map<string, {
      provider_order_id: string | null;
      status: string | null;
      provider_state: string | null;
      captured_amount_pence: number | null;
    }>();
    if (sessionIds.length > 0) {
      const { data: sessions } = await gate.supabase
        .from("payment_sessions")
        .select("id, provider_order_id, status, provider_state, captured_amount_pence")
        .in("id", sessionIds);
      for (const s of sessions ?? []) {
        sessionsById.set(String(s.id), {
          provider_order_id: s.provider_order_id ? String(s.provider_order_id) : null,
          status: s.status ? String(s.status) : null,
          provider_state: s.provider_state ? String(s.provider_state) : null,
          captured_amount_pence: s.captured_amount_pence != null
            ? Math.round(Number(s.captured_amount_pence) || 0)
            : null,
        });
      }
    }

    const eventsByReceivable = new Map<string, Array<Record<string, unknown>>>();
    if (includeEvents && receivableIds.length > 0) {
      const { data: events, error: evErr } = await gate.supabase
        .from("customer_receivable_events")
        .select(
          "id, receivable_id, event_type, amount_pence, payment_session_id, trip_id, actor_role, note, metadata, created_at",
        )
        .in("receivable_id", receivableIds)
        .order("created_at", { ascending: true });
      if (!evErr) {
        for (const e of events ?? []) {
          const rid = String(e.receivable_id);
          const list = eventsByReceivable.get(rid) ?? [];
          list.push(e as Record<string, unknown>);
          eventsByReceivable.set(rid, list);
        }
      }
    }

    const receivables = rows.map((r) => {
      const id = String(r.id);
      const reservedSessionId = r.reserved_payment_session_id
        ? String(r.reserved_payment_session_id)
        : null;
      const sourceSessionId = r.source_payment_session_id
        ? String(r.source_payment_session_id)
        : null;
      const reservedSession = reservedSessionId
        ? sessionsById.get(reservedSessionId) ?? null
        : null;
      const sourceSession = sourceSessionId
        ? sessionsById.get(sourceSessionId) ?? null
        : null;
      const customer = customersById.get(String(r.customer_id)) ?? null;
      const trip = tripsById.get(String(r.source_trip_id)) ?? null;

      return {
        id,
        customer_id: String(r.customer_id),
        customer_display_name: customer?.display_name ?? null,
        customer_email: customer?.email ?? null,
        source_trip_id: String(r.source_trip_id),
        source_trip_code: trip?.trip_code ?? null,
        source_payment_session_id: sourceSessionId,
        source_authorisation_id: r.source_authorisation_id
          ? String(r.source_authorisation_id)
          : null,
        source_failed_authorisation: r.source_authorisation_id
          ? String(r.source_authorisation_id)
          : (sourceSession?.provider_order_id ?? null),
        source_type: String(r.source_type ?? ""),
        reason_code: String(r.reason_code ?? ""),
        original_amount_pence: Math.round(Number(r.original_amount_pence) || 0),
        outstanding_amount_pence: Math.round(Number(r.outstanding_amount_pence) || 0),
        status: String(r.status ?? ""),
        currency: String(r.currency ?? "gbp"),
        reserved_payment_session_id: reservedSessionId,
        reserved_session_status: reservedSession?.status ?? null,
        reserved_provider_state: reservedSession?.provider_state ?? null,
        recovery_provider_order_id: reservedSession?.provider_order_id ?? null,
        recovery_captured_amount_pence: reservedSession?.captured_amount_pence ?? null,
        idempotency_key: r.idempotency_key ? String(r.idempotency_key) : null,
        created_at: r.created_at ?? null,
        settled_at: r.settled_at ?? null,
        waived_at: r.waived_at ?? null,
        metadata: r.metadata ?? {},
        events: eventsByReceivable.get(id) ?? [],
      };
    });

    const openTotal = receivables
      .filter((r) => r.status === "OPEN" || r.status === "RESERVED")
      .reduce((s, r) => s + r.outstanding_amount_pence, 0);

    return json({
      success: true,
      ledger_available: true,
      read_only: true,
      waive_forbidden: true,
      balance_edit_forbidden: true,
      open_outstanding_pence: openTotal,
      receivables,
    });
  } catch (err) {
    console.error("[admin-customer-receivables]", err);
    return json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }, 500);
  }
});
