/**
 * Revolut provider-only / orphan payment SSOT — Financial Reconciliation + admin recovery.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  mapRevolutStateToPaymentStatus,
  refundRevolutOrder,
  retrieveRevolutOrder,
} from "./revolutOrders.ts";
import { isRevolutAuthorisedState } from "./revolutPaymentConfirmation.ts";
import { resolveRevolutMerchantContext } from "./revolutMerchantContext.ts";
import { classifyRevolutHoldReconciliation } from "./revolutPreauthReleaseSSOT.ts";
import {
  finalizeBookingAfterPaymentFromSession,
  loadPaymentSession,
  markPaymentSessionOrphaned,
} from "./paymentSessionSSOT.ts";
import { releaseHoldForPaymentSession } from "./holdReleaseSSOT.ts";

export type RevolutHoldReconciliationStatus =
  | "authorised_hold"
  | "released_hold"
  | "captured_after_completion"
  | "refunded_wrong_capture"
  | "orphan_authorisation";

export type RevolutOrphanReconciliationRow = {
  id: string;
  source: "orphan_payments" | "payment_sessions";
  payment_provider: "revolut";
  provider_order_id: string;
  amount_pence: number;
  currency: string;
  created_at: string;
  customer_user_id: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  card_last4: string | null;
  client_action_id: string | null;
  service_area_id: string | null;
  session_status: string | null;
  reversal_status: string | null;
  failure_reason: string | null;
  trip_id: string | null;
  provider_order_state: string | null;
  provider_payment_status: string | null;
  hold_reconciliation_status: RevolutHoldReconciliationStatus;
  payment_invariant_violation: boolean;
  is_provider_only: boolean;
  can_cancel: boolean;
  can_refund: boolean;
  can_link: boolean;
  has_booking_snapshot: boolean;
};

function formatCustomerName(row: {
  first_name?: string | null;
  last_name?: string | null;
} | null): string | null {
  if (!row) return null;
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return name || null;
}

export async function syncRevolutOrphanFromSession(
  supabase: SupabaseClient,
  session: Record<string, unknown>,
  orderState?: string | null,
): Promise<void> {
  const providerOrderId = String(session.provider_order_id ?? "");
  if (!providerOrderId) return;
  const tripId = session.trip_id as string | null;
  if (tripId) return;

  const state = String(orderState ?? "").toUpperCase();
  const isOpen =
    isRevolutAuthorisedState(state)
    || state === "COMPLETED"
    || state === "PROCESSING";

  if (!isOpen && session.status !== "payment_orphaned") return;

  const userId = String(session.user_id ?? "");
  if (!userId) return;

  await supabase.from("orphan_payments").upsert({
    stripe_payment_intent_id: providerOrderId,
    provider_order_id: providerOrderId,
    payment_provider: "revolut",
    user_id: userId,
    customer_id: (session.customer_id as string | null) ?? null,
    amount_pence: Number(session.authorised_amount_pence ?? 0),
    currency: "gbp",
    payment_status: mapRevolutStateToPaymentStatus(state) ?? "authorized",
    client_action_id: (session.client_action_id as string | null) ?? null,
    service_area_id: (session.service_area_id as string | null) ?? null,
    failure_reason: (session.failure_reason as string | null)
      ?? "provider_payment_without_trip",
    reversal_status: "pending",
    card_last4: null,
    metadata: {
      provider: "revolut",
      booking_snapshot: session.booking_snapshot ?? null,
      session_status: session.status ?? null,
      provider_order_state: state || null,
    },
    updated_at: new Date().toISOString(),
  }, { onConflict: "stripe_payment_intent_id" });

  if (isOpen && session.status !== "payment_orphaned") {
    await supabase
      .from("payment_sessions")
      .update({
        status: "payment_orphaned",
        failure_reason: "provider_payment_without_trip",
        updated_at: new Date().toISOString(),
      })
      .eq("id", session.id as string);
  }
}

export async function listRevolutOrphanReconciliationRows(
  supabase: SupabaseClient,
  args: { refreshProviderState?: boolean } = {},
): Promise<{
  rows: RevolutOrphanReconciliationRow[];
  provider_only_count: number;
  total_pending_pence: number;
}> {
  const { data: sessions } = await supabase
    .from("payment_sessions")
    .select("*")
    .eq("payment_provider", "revolut")
    .is("trip_id", null)
    .in("status", ["pending_payment", "payment_authorised", "payment_orphaned"])
    .order("created_at", { ascending: false })
    .limit(100);

  let merchant: Awaited<ReturnType<typeof resolveRevolutMerchantContext>> | null = null;
  if (args.refreshProviderState !== false) {
    try {
      merchant = await resolveRevolutMerchantContext(supabase, "live");
    } catch {
      merchant = null;
    }
  }

  const orderStateById = new Map<string, string>();
  if (merchant) {
    for (const session of sessions ?? []) {
      const orderId = String(session.provider_order_id ?? "");
      if (!orderId || orderStateById.has(orderId)) continue;
      try {
        const order = await retrieveRevolutOrder(
          merchant.environment,
          merchant.secretKey,
          orderId,
        );
        const state = String(order.state ?? "").toUpperCase();
        orderStateById.set(orderId, state);
        if (isRevolutAuthorisedState(state) || state === "COMPLETED") {
          await syncRevolutOrphanFromSession(supabase, session as Record<string, unknown>, state);
        }
      } catch {
        /* skip live refresh for this order */
      }
    }
  }

  const { data: orphanRows } = await supabase
    .from("orphan_payments")
    .select("*")
    .or("payment_provider.eq.revolut,metadata->>provider.eq.revolut")
    .in("reversal_status", ["pending", "failed"])
    .order("created_at", { ascending: false })
    .limit(100);

  const { data: customers } = await supabase
    .from("customers")
    .select("id, user_id, first_name, last_name, email");

  const customerByUserId = new Map(
    (customers ?? []).map((c) => [c.user_id as string, c]),
  );
  const customerById = new Map(
    (customers ?? []).map((c) => [c.id as string, c]),
  );

  const platformPmIds = new Set<string>();
  for (const s of sessions ?? []) {
    const pm = s.platform_payment_method_id as string | null;
    if (pm) platformPmIds.add(pm);
  }
  for (const o of orphanRows ?? []) {
    const pm = (o.metadata as Record<string, unknown> | null)?.platform_payment_method_id;
    if (typeof pm === "string") platformPmIds.add(pm);
  }

  const { data: tokenRows } = platformPmIds.size > 0
    ? await supabase
      .from("customer_saved_payment_method_tokens")
      .select("platform_payment_method_id, last4")
      .in("platform_payment_method_id", [...platformPmIds])
    : { data: [] as Array<{ platform_payment_method_id: string; last4: string | null }> };

  const last4ByPm = new Map(
    (tokenRows ?? []).map((t) => [t.platform_payment_method_id as string, t.last4 as string | null]),
  );

  const rowByOrderId = new Map<string, RevolutOrphanReconciliationRow>();

  for (const session of sessions ?? []) {
    const orderId = String(session.provider_order_id ?? "");
    if (!orderId) continue;
    const userId = (session.user_id as string | null) ?? null;
    const customer =
      (session.customer_id ? customerById.get(session.customer_id as string) : null)
      ?? (userId ? customerByUserId.get(userId) : null);
    const pmId = session.platform_payment_method_id as string | null;
    const state = orderStateById.get(orderId) ?? null;
    const paymentStatus = mapRevolutStateToPaymentStatus(state ?? undefined);
    const bookingSnapshot = session.booking_snapshot as Record<string, unknown> | null;
    const hasBookingSnapshot = Boolean(
      bookingSnapshot?.pickup && bookingSnapshot?.dropoff && bookingSnapshot?.client_action_id,
    );

    const holdStatus = classifyRevolutHoldReconciliation({
      providerOrderState: state,
      reversalStatus: "pending",
      hasTrip: false,
      sessionOrphaned: String(session.status ?? "") === "payment_orphaned",
    });

    rowByOrderId.set(orderId, {
      id: String(session.id),
      source: "payment_sessions",
      payment_provider: "revolut",
      provider_order_id: orderId,
      amount_pence: Number(session.authorised_amount_pence ?? 0),
      currency: "gbp",
      created_at: String(session.created_at),
      customer_user_id: userId,
      customer_id: (session.customer_id as string | null) ?? null,
      customer_name: formatCustomerName(customer),
      customer_email: (customer?.email as string | null) ?? null,
      card_last4: pmId ? last4ByPm.get(pmId) ?? null : null,
      client_action_id: (session.client_action_id as string | null) ?? null,
      service_area_id: (session.service_area_id as string | null) ?? null,
      session_status: String(session.status ?? ""),
      reversal_status: "pending",
      failure_reason: (session.failure_reason as string | null) ?? null,
      trip_id: null,
      provider_order_state: state,
      provider_payment_status: paymentStatus,
      hold_reconciliation_status: holdStatus,
      payment_invariant_violation: holdStatus === "refunded_wrong_capture",
      is_provider_only: true,
      can_cancel: isRevolutAuthorisedState(state) || state === "PROCESSING",
      can_refund: state === "COMPLETED",
      can_link: hasBookingSnapshot,
      has_booking_snapshot: hasBookingSnapshot,
    });
  }

  for (const orphan of orphanRows ?? []) {
    const orderId = String(orphan.provider_order_id ?? orphan.stripe_payment_intent_id ?? "");
    if (!orderId) continue;
    const userId = (orphan.user_id as string | null) ?? null;
    const customer =
      (orphan.customer_id ? customerById.get(orphan.customer_id as string) : null)
      ?? (userId ? customerByUserId.get(userId) : null);
    const state =
      orderStateById.get(orderId)
      ?? ((orphan.metadata as Record<string, unknown> | null)?.provider_order_state as string | undefined)
      ?? null;
    const paymentStatus = mapRevolutStateToPaymentStatus(state ?? undefined)
      ?? (orphan.payment_status as string | null);
    const bookingSnapshot = (orphan.metadata as Record<string, unknown> | null)?.booking_snapshot;
    const hasBookingSnapshot = Boolean(
      bookingSnapshot
      && typeof bookingSnapshot === "object"
      && (bookingSnapshot as Record<string, unknown>).pickup,
    );
    const existing = rowByOrderId.get(orderId);
    const pmId = (orphan.metadata as Record<string, unknown> | null)?.platform_payment_method_id;

    const orphanMeta = (orphan.metadata as Record<string, unknown> | null) ?? null;
    const paymentInvariantViolation = orphanMeta?.payment_invariant_violation === true;
    const holdStatus = classifyRevolutHoldReconciliation({
      providerOrderState: state,
      tripStatus: null,
      reversalStatus: String(orphan.reversal_status ?? "pending"),
      paymentInvariantViolation,
      hasTrip: Boolean(orphan.trip_id),
      sessionOrphaned: true,
    });

    rowByOrderId.set(orderId, {
      id: String(orphan.id),
      source: "orphan_payments",
      payment_provider: "revolut",
      provider_order_id: orderId,
      amount_pence: Number(orphan.amount_pence ?? existing?.amount_pence ?? 0),
      currency: String(orphan.currency ?? "gbp"),
      created_at: String(orphan.created_at ?? existing?.created_at ?? new Date().toISOString()),
      customer_user_id: userId ?? existing?.customer_user_id ?? null,
      customer_id: (orphan.customer_id as string | null) ?? existing?.customer_id ?? null,
      customer_name: formatCustomerName(customer) ?? existing?.customer_name ?? null,
      customer_email: (customer?.email as string | null) ?? existing?.customer_email ?? null,
      card_last4:
        (orphan.card_last4 as string | null)
        ?? (pmId && typeof pmId === "string" ? last4ByPm.get(pmId) ?? null : null)
        ?? existing?.card_last4
        ?? null,
      client_action_id: (orphan.client_action_id as string | null) ?? existing?.client_action_id ?? null,
      service_area_id: (orphan.service_area_id as string | null) ?? existing?.service_area_id ?? null,
      session_status: existing?.session_status ?? String(orphanMeta?.session_status ?? ""),
      reversal_status: String(orphan.reversal_status ?? "pending"),
      failure_reason: (orphan.failure_reason as string | null) ?? existing?.failure_reason ?? null,
      trip_id: (orphan.trip_id as string | null) ?? null,
      provider_order_state: state,
      provider_payment_status: paymentStatus,
      hold_reconciliation_status: holdStatus,
      payment_invariant_violation: paymentInvariantViolation,
      is_provider_only: !(orphan.trip_id as string | null),
      can_cancel: isRevolutAuthorisedState(state) || state === "PROCESSING",
      can_refund: state === "COMPLETED",
      can_link: hasBookingSnapshot,
      has_booking_snapshot: hasBookingSnapshot,
    });
  }

  const rows = [...rowByOrderId.values()].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const provider_only_count = rows.filter((r) => r.is_provider_only && r.reversal_status === "pending").length;
  const total_pending_pence = rows
    .filter((r) => r.is_provider_only && r.reversal_status === "pending")
    .reduce((sum, r) => sum + r.amount_pence, 0);

  return { rows, provider_only_count, total_pending_pence };
}

export async function recoverRevolutOrphanPayment(
  supabase: SupabaseClient,
  args: {
    providerOrderId: string;
    action: "cancel" | "refund" | "link";
    adminUserId: string;
    dryRun?: boolean;
    supabaseUrl: string;
    serviceRoleKey: string;
  },
): Promise<Record<string, unknown>> {
  const orderId = args.providerOrderId.trim();
  if (!orderId) throw new Error("provider_order_id is required");

  const session = await loadPaymentSession(supabase, { providerOrderId: orderId });
  const { data: orphanRow } = await supabase
    .from("orphan_payments")
    .select("*")
    .eq("stripe_payment_intent_id", orderId)
    .maybeSingle();

  const { data: trip } = await supabase
    .from("trips")
    .select("id, trip_code")
    .or(`provider_order_id.eq.${orderId},stripe_payment_intent_id.eq.${orderId}`)
    .maybeSingle();

  if (trip?.id) {
    return {
      action: "already_linked",
      trip_id: trip.id,
      trip_code: trip.trip_code,
    };
  }

  const merchant = await resolveRevolutMerchantContext(supabase, "live");
  const order = await retrieveRevolutOrder(merchant.environment, merchant.secretKey, orderId);
  const state = String(order.state ?? "").toUpperCase();
  const amountPence = Number(order.amount ?? session?.authorised_amount_pence ?? orphanRow?.amount_pence ?? 0);

  if (args.dryRun) {
    return {
      dry_run: true,
      action: args.action,
      provider_order_id: orderId,
      provider_order_state: state,
      amount_pence: amountPence,
      can_cancel: isRevolutAuthorisedState(state) || state === "PROCESSING",
      can_refund: state === "COMPLETED",
      can_link: Boolean(session?.booking_snapshot),
    };
  }

  if (args.action === "link") {
    const finalize = await finalizeBookingAfterPaymentFromSession(supabase, {
      providerOrderId: orderId,
      clientActionId: (session?.client_action_id as string | null) ?? null,
      supabaseUrl: args.supabaseUrl,
      serviceRoleKey: args.serviceRoleKey,
    });
    if (finalize.tripId) {
      await supabase.from("orphan_payments").upsert({
        stripe_payment_intent_id: orderId,
        provider_order_id: orderId,
        payment_provider: "revolut",
        reversal_status: "linked",
        trip_id: finalize.tripId,
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: "stripe_payment_intent_id" });
      return { action: "linked", trip_id: finalize.tripId };
    }
    throw new Error(finalize.error ?? "link_failed");
  }

  if (args.action === "cancel") {
    if (!isRevolutAuthorisedState(state) && state !== "PROCESSING" && state !== "PENDING") {
      throw new Error(`Order is not cancellable (state=${state})`);
    }

    const release = await releaseHoldForPaymentSession(supabase, {
      providerOrderId: orderId,
      clientActionId: (session?.client_action_id as string | null) ?? null,
      terminalReason: "admin_orphan_cancel",
      source: "revolut-orphan-payments-ssot",
      idempotencyKey: `admin_orphan_cancel_${orderId}`,
      session: session as Record<string, unknown> | null,
    });

    if (!release.released && !release.skipped) {
      throw new Error(release.error ?? release.status ?? "release_failed");
    }

    await supabase.from("orphan_payments").upsert({
      stripe_payment_intent_id: orderId,
      provider_order_id: orderId,
      payment_provider: "revolut",
      user_id: (session?.user_id as string | null) ?? orphanRow?.user_id ?? null,
      amount_pence: amountPence,
      currency: "gbp",
      payment_status: "canceled",
      reversal_status: "cancelled",
      resolved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: { provider: "revolut", recovered_by: args.adminUserId, release_status: release.status },
    }, { onConflict: "stripe_payment_intent_id" });

    await supabase.from("admin_payment_audit").insert({
      action: "revolut_orphan_cancelled",
      provider: "revolut",
      provider_payment_id: orderId,
      admin_user_id: args.adminUserId,
      metadata: { provider_order_state: state, amount_pence: amountPence, release },
    });

    return { action: "cancelled", provider_order_id: orderId, state, release };
  }

  if (args.action === "refund") {
    if (state !== "COMPLETED" && !isRevolutAuthorisedState(state)) {
      throw new Error(`Order is not refundable (state=${state}) — try cancel for authorised holds`);
    }
    const refund = await refundRevolutOrder(
      merchant.environment,
      merchant.secretKey,
      orderId,
      amountPence,
      "admin_orphan_recovery",
    );
    await supabase.from("orphan_payments").upsert({
      stripe_payment_intent_id: orderId,
      provider_order_id: orderId,
      payment_provider: "revolut",
      user_id: (session?.user_id as string | null) ?? orphanRow?.user_id ?? null,
      amount_pence: amountPence,
      currency: "gbp",
      payment_status: "refunded",
      reversal_status: "refunded",
      resolved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: {
        provider: "revolut",
        recovered_by: args.adminUserId,
        revolut_refund_id: refund.id ?? null,
      },
    }, { onConflict: "stripe_payment_intent_id" });

    await supabase.from("admin_payment_audit").insert({
      action: "revolut_orphan_refunded",
      provider: "revolut",
      provider_payment_id: orderId,
      admin_user_id: args.adminUserId,
      metadata: { provider_order_state: state, amount_pence: amountPence, refund_id: refund.id ?? null },
    });

    return { action: "refunded", provider_order_id: orderId, refund };
  }

  throw new Error(`Unknown action: ${args.action}`);
}
