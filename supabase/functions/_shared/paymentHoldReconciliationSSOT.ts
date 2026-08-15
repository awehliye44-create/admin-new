/**
 * Admin payment holds reconciliation — classification + listing SSOT.
 * Provider CANCELLED/REVERTED persist on refresh; one row per provider+order;
 * money-at-risk is server-side only.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import type {
  PaymentHoldClassification,
  PaymentHoldReconciliationRow,
} from "../../../shared/paymentHoldReconciliation.ts";
import {
  ACTIVE_ATTENTION_CLASSES,
  classifyPaymentHoldAttention,
  holdIdentityKey,
  legacyHoldClassificationLabel,
  mapRevolutProviderHoldState,
  paymentHoldActionPolicy,
  summariseMoneyAtRisk,
  type PaymentHoldAttentionClass,
} from "../../../shared/paymentHoldClassificationSSOT.ts";
import { retrieveRevolutOrder } from "./revolutOrders.ts";
import { resolveRevolutMerchantContext } from "./revolutMerchantContext.ts";
import {
  persistProviderTerminalHoldState,
  recordProviderStateVerification,
  closeCompanionOrphanPayments,
} from "./paymentHoldProviderTerminalSSOT.ts";

export function classifyPaymentHoldRow(args: {
  sessionStatus: string | null;
  tripStatus: string | null;
  paymentHoldStatus: string | null;
  releasedAt: string | null;
  capturedAt: string | null;
  capturedAmountPence?: number | null;
  feeStatus?: string | null;
  tripId: string | null;
  ageMinutes: number;
  releaseFailureReason: string | null;
  holdReleaseState?: string | null;
  holdTerminalReason?: string | null;
  tripUpdatedAt?: string | null;
  providerOrderState?: string | null;
  orphanReversalStatus?: string | null;
  companionSessionReleased?: boolean;
  purposeLegacy?: boolean;
  recoveryAttemptCount?: number;
}): {
  classification: PaymentHoldClassification;
  hold_classification: PaymentHoldReconciliationRow["hold_classification"];
  attention_class: PaymentHoldAttentionClass;
  in_active_queue: boolean;
} {
  const ageMinutes = args.tripUpdatedAt && args.tripId
    ? Math.max(
      args.ageMinutes,
      (Date.now() - new Date(args.tripUpdatedAt).getTime()) / 60_000,
    )
    : args.ageMinutes;

  const result = classifyPaymentHoldAttention({
    sessionStatus: args.sessionStatus,
    tripStatus: args.tripStatus,
    paymentHoldStatus: args.paymentHoldStatus,
    releasedAt: args.releasedAt,
    capturedAt: args.capturedAt,
    capturedAmountPence: args.capturedAmountPence,
    feeStatus: args.feeStatus,
    tripId: args.tripId,
    ageMinutes,
    releaseFailureReason: args.releaseFailureReason,
    holdReleaseState: args.holdReleaseState,
    holdTerminalReason: args.holdTerminalReason,
    providerOrderState: args.providerOrderState,
    orphanReversalStatus: args.orphanReversalStatus,
    companionSessionReleased: args.companionSessionReleased,
    purposeLegacy: args.purposeLegacy,
    recoveryAttemptCount: args.recoveryAttemptCount,
  });

  return {
    classification: result.classification,
    hold_classification: legacyHoldClassificationLabel(result.attention_class),
    attention_class: result.attention_class,
    in_active_queue: result.in_active_queue,
  };
}

function formatCustomerName(row: {
  first_name?: string | null;
  last_name?: string | null;
} | null): string | null {
  if (!row) return null;
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return name || null;
}

function orphanPurposeLegacy(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  return (metadata as Record<string, unknown>).purpose === "save_card";
}

export type PaymentHoldsListView = "attention" | "history" | "all";

export async function listPaymentHoldsRequiringAttention(
  supabase: SupabaseClient,
  args: {
    refreshProviderState?: boolean;
    limit?: number;
    view?: PaymentHoldsListView;
    filters?: {
      dateFrom?: string | null;
      dateTo?: string | null;
      customerId?: string | null;
      tripId?: string | null;
      provider?: string | null;
      paymentSessionId?: string | null;
      providerOrderId?: string | null;
    };
  } = {},
): Promise<{
  rows: PaymentHoldReconciliationRow[];
  history_rows: PaymentHoldReconciliationRow[];
  summary: {
    total: number;
    green: number;
    amber: number;
    red: number;
    resolved: number;
    total_hold_pence: number;
    active_hold_count: number;
    active_hold_amount_pence: number;
    resolved_count: number;
    resolved_amount_pence: number;
    unknown_count: number;
  };
  /** True when live provider refresh was requested but at least one retrieve failed / merchant missing. */
  provider_refresh_partial: boolean;
}> {
  const limit = Math.min(1000, Math.max(1, args.limit ?? 100));
  const view: PaymentHoldsListView = args.view ?? "attention";
  const now = Date.now();
  const shouldRefresh = args.refreshProviderState === true;
  const filters = args.filters ?? {};

  let sessionQuery = supabase
    .from("payment_sessions")
    .select(
      "id, status, payment_provider, provider_order_id, authorised_amount_pence, captured_amount_pence, released_amount_pence, refunded_amount_pence, provider_processing_fee_pence, fee_status, provider_capture_id, created_at, authorised_at, released_at, captured_at, refunded_at, trip_id, user_id, customer_id, client_action_id, release_attempt_count, recovery_attempt_count, release_failure_reason, hold_terminal_reason, hold_release_state, failure_reason, metadata, provider_state, provider_state_verified_at, provider_state_verified_by",
    )
    .order("created_at", { ascending: false })
    .limit(Math.min(1000, Math.max(limit, view === "history" ? Math.max(limit, 300) : limit * 2)));

  if (filters.paymentSessionId) sessionQuery = sessionQuery.eq("id", filters.paymentSessionId);
  if (filters.providerOrderId) sessionQuery = sessionQuery.eq("provider_order_id", filters.providerOrderId);
  if (filters.tripId) sessionQuery = sessionQuery.eq("trip_id", filters.tripId);
  if (filters.customerId) sessionQuery = sessionQuery.eq("customer_id", filters.customerId);
  if (filters.provider) sessionQuery = sessionQuery.eq("payment_provider", filters.provider);
  if (filters.dateFrom) sessionQuery = sessionQuery.gte("created_at", filters.dateFrom);
  if (filters.dateTo) {
    const toBound = filters.dateTo.length <= 10
      ? `${filters.dateTo}T23:59:59.999Z`
      : filters.dateTo;
    sessionQuery = sessionQuery.lte("created_at", toBound);
  }

  const { data: sessions } = await sessionQuery;

  const tripIds = [...new Set((sessions ?? []).map((s) => s.trip_id).filter(Boolean))] as string[];
  const tripById = new Map<string, Record<string, unknown>>();
  if (tripIds.length > 0) {
    const { data: trips } = await supabase
      .from("trips")
      .select("id, trip_code, status, payment_hold_status, passenger_id, updated_at, driver_id")
      .in("id", tripIds);
    for (const t of trips ?? []) {
      tripById.set(t.id as string, t as Record<string, unknown>);
    }
  }

  const customerIds = [...new Set((sessions ?? []).map((s) => s.customer_id).filter(Boolean))] as string[];
  const { data: customers } = customerIds.length > 0
    ? await supabase.from("customers").select("id, user_id, first_name, last_name, email").in("id", customerIds)
    : { data: [] };
  const customerById = new Map((customers ?? []).map((c) => [c.id as string, c]));

  let merchant: Awaited<ReturnType<typeof resolveRevolutMerchantContext>> | null = null;
  let providerRefreshPartial = false;
  if (shouldRefresh) {
    try {
      merchant = await resolveRevolutMerchantContext(supabase, "live");
    } catch {
      merchant = null;
      providerRefreshPartial = true;
    }
    if (!merchant) providerRefreshPartial = true;
  }

  const orderStateById = new Map<string, string>();
  const orderPayloadById = new Map<string, Record<string, unknown>>();

  async function fetchProviderState(
    paymentProvider: string,
    orderId: string,
  ): Promise<string | null> {
    if (!orderId) return null;
    // Live refresh currently supported for Revolut only; other providers keep DB state.
    if (String(paymentProvider).toLowerCase() !== "revolut") return null;
    if (!merchant) return null;
    if (orderStateById.has(orderId)) return orderStateById.get(orderId) ?? null;
    try {
      const order = await retrieveRevolutOrder(merchant.environment, merchant.secretKey, orderId);
      const state = String(order.state ?? "").toUpperCase();
      orderStateById.set(orderId, state);
      orderPayloadById.set(orderId, order as unknown as Record<string, unknown>);
      return state;
    } catch {
      // Do not persist transient retrieve failures as terminal — keep verified DB state.
      providerRefreshPartial = true;
      return null;
    }
  }

  // Prefetch unique Revolut orders with bounded concurrency (list load used to await serially).
  if (shouldRefresh && merchant) {
    const uniqueOrders: string[] = [];
    const seen = new Set<string>();
    for (const session of sessions ?? []) {
      if (String(session.payment_provider ?? "").toLowerCase() !== "revolut") continue;
      const oid = String(session.provider_order_id ?? "");
      if (!oid || seen.has(oid)) continue;
      seen.add(oid);
      uniqueOrders.push(oid);
      if (uniqueOrders.length >= 40) break; // cap list-time live refresh
    }
    const concurrency = 8;
    for (let i = 0; i < uniqueOrders.length; i += concurrency) {
      const chunk = uniqueOrders.slice(i, i + concurrency);
      await Promise.all(chunk.map((oid) => fetchProviderState("revolut", oid)));
    }
  }

  // Primary identity map: payment_provider + provider_order_id
  const seenOrderIds = new Set<string>();
  const allBuilt: PaymentHoldReconciliationRow[] = [];

  for (const session of sessions ?? []) {
    const paymentProvider = String(session.payment_provider ?? "unknown");
    const providerOrderId = String(session.provider_order_id ?? "");
    const identity = holdIdentityKey(paymentProvider, providerOrderId);
    if (identity) seenOrderIds.add(providerOrderId);

    let providerState = orderStateById.get(providerOrderId) ?? null;
    if (shouldRefresh && providerOrderId) {
      providerState = await fetchProviderState(paymentProvider, providerOrderId);
      if (providerState) {
        const canonical = mapRevolutProviderHoldState(providerState);
        if (
          canonical === "CANCELLED"
          || canonical === "REVERTED"
          || canonical === "CAPTURED"
          || canonical === "REFUNDED"
          || canonical === "FAILED"
        ) {
          await persistProviderTerminalHoldState(supabase, {
            paymentProvider,
            providerOrderId,
            providerStateRaw: providerState,
            source: "admin_refresh",
            providerPayload: orderPayloadById.get(providerOrderId) ?? null,
          });
          // Re-read session after persist
          const { data: refreshed } = await supabase
            .from("payment_sessions")
            .select(
              "id, status, released_at, captured_at, captured_amount_pence, refunded_amount_pence, provider_processing_fee_pence, fee_status, provider_capture_id, hold_terminal_reason, hold_release_state, release_failure_reason, released_amount_pence, metadata, recovery_attempt_count, provider_state, provider_state_verified_at, provider_state_verified_by",
            )
            .eq("id", session.id)
            .maybeSingle();
          if (refreshed) {
            session.status = refreshed.status;
            session.released_at = refreshed.released_at;
            session.captured_at = refreshed.captured_at;
            session.captured_amount_pence = refreshed.captured_amount_pence;
            session.refunded_amount_pence = refreshed.refunded_amount_pence;
            session.provider_processing_fee_pence = refreshed.provider_processing_fee_pence;
            session.fee_status = refreshed.fee_status;
            session.provider_capture_id = refreshed.provider_capture_id;
            session.hold_terminal_reason = refreshed.hold_terminal_reason;
            session.hold_release_state = refreshed.hold_release_state;
            session.release_failure_reason = refreshed.release_failure_reason;
            session.released_amount_pence = refreshed.released_amount_pence;
            session.metadata = refreshed.metadata;
            session.provider_state = refreshed.provider_state;
            session.provider_state_verified_at = refreshed.provider_state_verified_at;
            session.provider_state_verified_by = refreshed.provider_state_verified_by;
            session.recovery_attempt_count = refreshed.recovery_attempt_count;
          }

          // Safe projection repair only — never moves money.
          const meta = (session.metadata && typeof session.metadata === "object")
            ? session.metadata as Record<string, unknown>
            : {};
          const releaseRef = typeof meta.provider_release_reference === "string"
            ? meta.provider_release_reference
            : (session as { provider_release_reference?: string | null }).provider_release_reference ?? null;
          const localRelease = String(session.hold_release_state ?? "").toLowerCase();
          if (
            localRelease === "release_pending"
            && !releaseRef
            && (canonical === "CANCELLED" || canonical === "REVERTED" || canonical === "CAPTURED" || canonical === "FAILED")
          ) {
            await supabase
              .from("payment_sessions")
              .update({
                hold_release_state: canonical === "CANCELLED" || canonical === "REVERTED"
                  ? "released"
                  : null,
              })
              .eq("id", session.id);
            session.hold_release_state = canonical === "CANCELLED" || canonical === "REVERTED"
              ? "released"
              : null;
          }
        } else {
          await recordProviderStateVerification(supabase, {
            providerOrderId,
            providerStateRaw: providerState,
            source: "admin_refresh",
          });
        }
      }
    }

    // Prefer column, then metadata-verified state when refresh did not run
    if (!providerState && session.provider_state) {
      providerState = String(session.provider_state).toUpperCase();
    }
    if (!providerState && session.metadata && typeof session.metadata === "object") {
      const metaState = (session.metadata as Record<string, unknown>).provider_state_raw
        ?? (session.metadata as Record<string, unknown>).provider_state;
      if (typeof metaState === "string" && metaState.trim()) {
        providerState = String(metaState).toUpperCase();
      }
    }

    const trip = session.trip_id ? tripById.get(session.trip_id as string) : null;
    const customer = session.customer_id
      ? customerById.get(session.customer_id as string)
      : null;
    const anchor = session.authorised_at ?? session.created_at;
    const ageMinutes = anchor
      ? (now - new Date(String(anchor)).getTime()) / 60_000
      : 0;
    const tripStatus = trip ? String(trip.status ?? "") : null;
    const holdStatus = trip ? String(trip.payment_hold_status ?? "") : null;

    const classified = classifyPaymentHoldRow({
      sessionStatus: String(session.status ?? ""),
      tripStatus,
      paymentHoldStatus: holdStatus,
      releasedAt: session.released_at as string | null,
      capturedAt: session.captured_at as string | null,
      capturedAmountPence: session.captured_amount_pence == null
        ? null
        : Number(session.captured_amount_pence),
      feeStatus: (session.fee_status as string | null) ?? null,
      tripId: session.trip_id as string | null,
      ageMinutes,
      releaseFailureReason: session.release_failure_reason as string | null,
      holdReleaseState: session.hold_release_state as string | null,
      holdTerminalReason: session.hold_terminal_reason as string | null,
      tripUpdatedAt: trip ? String(trip.updated_at ?? "") : null,
      providerOrderState: providerState,
      recoveryAttemptCount: Number(session.recovery_attempt_count ?? 0),
    });

    const policy = paymentHoldActionPolicy({
      attentionClass: classified.attention_class,
      hasTrip: Boolean(session.trip_id),
      recoveryAttemptCount: Number(session.recovery_attempt_count ?? 0),
      releaseFailureReason: session.release_failure_reason as string | null,
      capturedAt: session.captured_at as string | null,
    });

    const meta = session.metadata && typeof session.metadata === "object"
      ? session.metadata as Record<string, unknown>
      : {};
    const verifiedAt = (session.provider_state_verified_at as string | null)
      ?? (typeof meta.provider_state_verified_at === "string" ? meta.provider_state_verified_at : null);
    const verifiedBy = (session.provider_state_verified_by as string | null)
      ?? (typeof meta.provider_state_verified_by === "string" ? meta.provider_state_verified_by : null);

    allBuilt.push({
      id: providerOrderId || String(session.id),
      payment_session_id: String(session.id),
      source: "payment_sessions",
      payment_provider: paymentProvider,
      provider_order_id: providerOrderId,
      amount_pence: session.authorised_amount_pence == null
        ? 0
        : Number(session.authorised_amount_pence),
      currency: "gbp",
      created_at: String(session.created_at),
      authorised_at: session.authorised_at as string | null,
      released_at: session.released_at as string | null,
      captured_at: session.captured_at as string | null,
      age_minutes: Math.round(ageMinutes * 10) / 10,
      customer_user_id: (customer?.user_id as string | null) ?? (session.user_id as string | null),
      customer_id: session.customer_id as string | null,
      customer_name: formatCustomerName(customer),
      customer_email: (customer?.email as string | null) ?? null,
      trip_id: session.trip_id as string | null,
      trip_code: trip ? String(trip.trip_code ?? "") : null,
      trip_status: tripStatus,
      driver_id: trip?.driver_id ? String(trip.driver_id) : null,
      payment_hold_status: holdStatus,
      session_status: String(session.status ?? ""),
      release_attempt_count: Number(session.release_attempt_count ?? 0),
      recovery_attempt_count: Number(session.recovery_attempt_count ?? 0),
      release_failure_reason: session.release_failure_reason as string | null,
      hold_terminal_reason: session.hold_terminal_reason as string | null,
      hold_release_state: session.hold_release_state as string | null,
      provider_order_state: providerState,
      classification: classified.classification,
      hold_classification: classified.hold_classification,
      attention_class: classified.attention_class,
      in_active_queue: classified.in_active_queue,
      can_release: policy.can_release,
      can_retry_release: policy.can_retry_release,
      can_retry_recovery: policy.can_retry_recovery,
      can_refund: policy.can_refund,
      can_open_trip: policy.can_open_trip,
      released_amount_pence: session.released_amount_pence == null
        ? null
        : Number(session.released_amount_pence),
      amount_display: (session.released_at && session.released_amount_pence == null)
        || (session.captured_at && session.captured_amount_pence == null)
        ? "AMOUNT_UNCONFIRMED"
        : null,
      resolution_source: verifiedBy,
      provider_state_verified_at: verifiedAt,
      orphan_evidence_id: null,
    });
  }

  // Orphans: supporting evidence only — never a second RED row when session exists.
  const { data: orphanRows } = await supabase
    .from("orphan_payments")
    .select(
      "id, payment_provider, provider_order_id, stripe_payment_intent_id, amount_pence, currency, payment_status, client_action_id, user_id, customer_id, trip_id, failure_reason, reversal_status, created_at, resolved_at, metadata",
    )
    .order("created_at", { ascending: false })
    .limit(Math.min(500, limit * 3));

  const orphanCustomerIds = [...new Set((orphanRows ?? []).map((o) => o.customer_id).filter(Boolean))] as string[];
  const orphanTripIds = [...new Set((orphanRows ?? []).map((o) => o.trip_id).filter(Boolean))] as string[];
  const missingOrphanTripIds = orphanTripIds.filter((id) => !tripById.has(id));
  if (missingOrphanTripIds.length > 0) {
    const { data: orphanTrips } = await supabase
      .from("trips")
      .select("id, trip_code, status, payment_hold_status, passenger_id, updated_at, driver_id")
      .in("id", missingOrphanTripIds);
    for (const t of orphanTrips ?? []) {
      tripById.set(t.id as string, t as Record<string, unknown>);
    }
  }
  if (orphanCustomerIds.length > 0) {
    const { data: orphanCustomers } = await supabase
      .from("customers")
      .select("id, user_id, first_name, last_name, email")
      .in("id", orphanCustomerIds);
    for (const c of orphanCustomers ?? []) {
      if (!customerById.has(c.id as string)) {
        customerById.set(c.id as string, c);
      }
    }
  }

  // Attach orphan evidence ids onto existing session rows; close stale companions on refresh.
  for (const orphan of orphanRows ?? []) {
    const paymentProvider = String(orphan.payment_provider ?? "unknown");
    const providerOrderId = String(orphan.provider_order_id ?? orphan.stripe_payment_intent_id ?? "");
    if (!providerOrderId) continue;

    if (seenOrderIds.has(providerOrderId)) {
      const companion = allBuilt.find((r) =>
        r.provider_order_id === providerOrderId
        && String(r.payment_provider).toLowerCase() === paymentProvider.toLowerCase()
      ) ?? allBuilt.find((r) => r.provider_order_id === providerOrderId);
      if (companion) {
        companion.orphan_evidence_id = String(orphan.id);
      }
      // Stale companion: session already released but orphan still pending.
      if (
        shouldRefresh
        && companion?.released_at
        && String(orphan.reversal_status) === "pending"
        && !orphan.resolved_at
      ) {
        await closeCompanionOrphanPayments(supabase, {
          paymentProvider,
          providerOrderId,
          resolutionReason: companion.hold_terminal_reason ?? "RESOLVED_COMPANION_SESSION",
          source: "admin_refresh",
        });
      }
      continue;
    }

    let providerState = orderStateById.get(providerOrderId) ?? null;
    if (shouldRefresh) {
      providerState = await fetchProviderState(paymentProvider, providerOrderId);
      if (providerState) {
        const canonical = mapRevolutProviderHoldState(providerState);
        if (
          canonical === "CANCELLED"
          || canonical === "REVERTED"
          || canonical === "CAPTURED"
          || canonical === "REFUNDED"
          || canonical === "FAILED"
        ) {
          await persistProviderTerminalHoldState(supabase, {
            paymentProvider,
            providerOrderId,
            providerStateRaw: providerState,
            source: "admin_refresh",
            providerPayload: orderPayloadById.get(providerOrderId) ?? null,
          });
        }
      }
    }

    // Check companion session released even if not in the limited session page.
    const { data: companionSession } = await supabase
      .from("payment_sessions")
      .select("id, released_at, captured_at, hold_terminal_reason, status")
      .eq("payment_provider", paymentProvider)
      .eq("provider_order_id", providerOrderId)
      .maybeSingle();

    const companionReleased = Boolean(
      companionSession?.released_at || companionSession?.captured_at,
    );

    if (companionReleased && String(orphan.reversal_status) === "pending" && shouldRefresh) {
      await closeCompanionOrphanPayments(supabase, {
        paymentProvider,
        providerOrderId,
        resolutionReason: String(companionSession?.hold_terminal_reason ?? "RESOLVED_COMPANION_SESSION"),
        source: "admin_refresh",
      });
    }

    // If companion session exists, never emit orphan as primary row.
    if (companionSession) {
      seenOrderIds.add(providerOrderId);
      continue;
    }

    seenOrderIds.add(providerOrderId);

    const customer = orphan.customer_id
      ? customerById.get(orphan.customer_id as string)
      : null;
    const ageMinutes = orphan.created_at
      ? (now - new Date(String(orphan.created_at)).getTime()) / 60_000
      : 0;
    const trip = orphan.trip_id ? tripById.get(orphan.trip_id as string) : null;
    const orphanResolved = ["resolved", "cancelled", "refunded", "linked"].includes(
      String(orphan.reversal_status ?? "").toLowerCase(),
    );

    const classified = classifyPaymentHoldRow({
      sessionStatus: "payment_orphaned",
      tripStatus: trip ? String(trip.status ?? "") : null,
      paymentHoldStatus: null,
      releasedAt: orphanResolved ? String(orphan.resolved_at ?? orphan.created_at) : null,
      capturedAt: null,
      tripId: orphan.trip_id as string | null,
      ageMinutes,
      releaseFailureReason: null,
      holdTerminalReason: null,
      providerOrderState: providerState,
      orphanReversalStatus: String(orphan.reversal_status ?? ""),
      companionSessionReleased: companionReleased,
      purposeLegacy: orphanPurposeLegacy(orphan.metadata),
    });

    // Re-classify after provider terminal persist may have closed orphan
    const effectiveClass = companionReleased
      ? classifyPaymentHoldRow({
        sessionStatus: "payment_orphaned",
        tripStatus: null,
        paymentHoldStatus: null,
        releasedAt: null,
        capturedAt: null,
        tripId: null,
        ageMinutes,
        releaseFailureReason: null,
        companionSessionReleased: true,
        providerOrderState: providerState,
      })
      : classified;

    const policy = paymentHoldActionPolicy({
      attentionClass: effectiveClass.attention_class,
      hasTrip: Boolean(orphan.trip_id),
      recoveryAttemptCount: 0,
      releaseFailureReason: orphan.failure_reason as string | null,
    });

    allBuilt.push({
      id: `orphan_${orphan.id}`,
      payment_session_id: String(orphan.id),
      source: "orphan_payments",
      payment_provider: paymentProvider,
      provider_order_id: providerOrderId,
      amount_pence: orphan.amount_pence == null ? 0 : Number(orphan.amount_pence),
      currency: String(orphan.currency ?? "gbp"),
      created_at: String(orphan.created_at),
      authorised_at: String(orphan.created_at),
      released_at: orphanResolved ? (orphan.resolved_at as string | null) : null,
      captured_at: null,
      age_minutes: Math.round(ageMinutes * 10) / 10,
      customer_user_id: (customer?.user_id as string | null) ?? (orphan.user_id as string | null),
      customer_id: orphan.customer_id as string | null,
      customer_name: formatCustomerName(customer),
      customer_email: (customer?.email as string | null) ?? null,
      trip_id: orphan.trip_id as string | null,
      trip_code: trip ? String(trip.trip_code ?? "") : null,
      trip_status: trip ? String(trip.status ?? "") : null,
      driver_id: trip?.driver_id ? String(trip.driver_id) : null,
      payment_hold_status: null,
      session_status: "payment_orphaned",
      release_attempt_count: 0,
      recovery_attempt_count: 0,
      release_failure_reason: orphan.failure_reason as string | null,
      hold_terminal_reason: orphan.failure_reason as string | null,
      hold_release_state: null,
      provider_order_state: providerState,
      classification: effectiveClass.classification,
      hold_classification: effectiveClass.hold_classification,
      attention_class: effectiveClass.attention_class,
      in_active_queue: effectiveClass.in_active_queue,
      can_release: policy.can_release,
      can_retry_release: policy.can_retry_release,
      can_retry_recovery: policy.can_retry_recovery,
      can_refund: policy.can_refund,
      can_open_trip: policy.can_open_trip,
      released_amount_pence: null,
      amount_display: null,
      resolution_source: null,
      provider_state_verified_at: null,
      orphan_evidence_id: String(orphan.id),
    });
  }

  const riskRows = allBuilt.map((r) => ({
    attention_class: (r.attention_class ?? "UNKNOWN_PROVIDER_STATE") as PaymentHoldAttentionClass,
    provider_state: mapRevolutProviderHoldState(r.provider_order_state),
    amount_pence: r.amount_pence > 0 ? r.amount_pence : null,
    in_active_queue: Boolean(r.in_active_queue),
    classification: r.classification as PaymentHoldClassification,
  }));
  const money = summariseMoneyAtRisk(riskRows);

  const attentionRows = allBuilt
    .filter((r) => r.in_active_queue && ACTIVE_ATTENTION_CLASSES.has(
      (r.attention_class ?? "UNKNOWN_PROVIDER_STATE") as PaymentHoldAttentionClass,
    ))
    .sort((a, b) => {
      const rank = { RED: 0, AMBER: 1, GREEN: 2 };
      return rank[a.classification] - rank[b.classification] || b.age_minutes - a.age_minutes;
    })
    .slice(0, limit);

  const historyRows = allBuilt
    .filter((r) => !r.in_active_queue)
    .sort((a, b) => b.age_minutes - a.age_minutes)
    .slice(0, limit);

  const rows = view === "history"
    ? historyRows
    : view === "all"
    ? [...attentionRows, ...historyRows].slice(0, limit)
    : attentionRows;

  const summary = {
    total: attentionRows.length,
    green: allBuilt.filter((r) => r.classification === "GREEN" && r.in_active_queue).length,
    amber: attentionRows.filter((r) => r.classification === "AMBER").length,
    red: attentionRows.filter((r) => r.classification === "RED").length,
    resolved: historyRows.length,
    // total_hold_pence = active money-at-risk only (SSOT) — UI must not re-sum.
    total_hold_pence: money.active_hold_amount_pence,
    active_hold_count: money.active_hold_count,
    active_hold_amount_pence: money.active_hold_amount_pence,
    resolved_count: money.resolved_count,
    resolved_amount_pence: money.resolved_amount_pence,
    unknown_count: money.unknown_count,
  };

  return { rows, history_rows: historyRows, summary, provider_refresh_partial: providerRefreshPartial };
}
