/**
 * Recovery run and its ops alert. Imported by the edge handler.
 * Kept separate so tests do not start the HTTP server.
 */
import {
  ensureShortfallReceivableOrException,
  selectShortfallRecoveryCandidates,
  SHORTFALL_SAFETY_STATE,
} from "../_shared/shortfallReceivableSafety.ts";

const BATCH = 25;

/** One open row. Repeats refresh it; they do not insert another. */
export const RECOVERY_JOB_ALERT = "finance:shortfall_recovery_job_unhealthy";

type QueryError = { message?: string; code?: string } | null;
type QueryResult = { data: unknown; error: QueryError };

type AlertQuery = {
  select: (...args: unknown[]) => AlertQuery;
  not: (...args: unknown[]) => AlertQuery;
  order: (...args: unknown[]) => AlertQuery;
  limit: (...args: unknown[]) => AlertQuery;
  eq: (...args: unknown[]) => AlertQuery;
  in: (...args: unknown[]) => AlertQuery;
  like: (...args: unknown[]) => AlertQuery;
  maybeSingle: () => Promise<QueryResult>;
  insert: (row: Record<string, unknown>) => Promise<QueryResult>;
  update: (row: Record<string, unknown>) => AlertQuery;
  then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) => Promise<unknown>;
};

export type AlertClient = {
  from: (table: string) => AlertQuery;
};

export type RecoveryRunBody = {
  ok: boolean;
  money_moved: false;
  provider_called: false;
  examined?: number;
  receivable_recorded?: number;
  exception_recorded?: number;
  escalated?: number;
  not_required?: number;
  errors?: number;
  error?: string;
  alert?: "inserted" | "refreshed" | "none" | "failed";
};

function alertRow(detail: string): Record<string, unknown> {
  return {
    fingerprint: RECOVERY_JOB_ALERT,
    category: "payment",
    severity: "critical",
    status: "open",
    source: "system",
    app: "backend",
    title: "Waiting shortfall recovery job needs attention",
    description: detail.slice(0, 500),
    metadata: { money_moved: false, provider_called: false },
  };
}

/**
 * Insert one open alert. A second failure updates that row's count and
 * description. The open-fingerprint unique index makes a second open row impossible.
 */
export async function raiseRecoveryJobAlert(
  supabase: AlertClient,
  detail: string,
): Promise<"inserted" | "refreshed" | "failed"> {
  const inserted = await supabase.from("ops_alerts").insert(alertRow(detail));
  if (!inserted.error) return "inserted";
  if (inserted.error.code !== "23505") {
    console.error("[reconcile-waiting-shortfall-markers] alert insert failed", inserted.error.message);
    return "failed";
  }

  const existing = await supabase
    .from("ops_alerts")
    .select("id, fingerprint_count")
    .eq("fingerprint", RECOVERY_JOB_ALERT)
    .in("status", ["open", "acknowledged"])
    .limit(1)
    .maybeSingle();
  const row = existing.data as { id?: string; fingerprint_count?: number } | null;
  if (existing.error || !row?.id) return "failed";

  const updated = await supabase
    .from("ops_alerts")
    .update({
      fingerprint_count: Math.max(1, Number(row.fingerprint_count) || 1) + 1,
      last_detected_at: new Date().toISOString(),
      description: detail.slice(0, 500),
    })
    .eq("id", row.id)
    .in("status", ["open", "acknowledged"]);
  if (updated.error) {
    console.error("[reconcile-waiting-shortfall-markers] alert refresh failed", updated.error.message);
    return "failed";
  }
  return "refreshed";
}

export async function runWaitingShortfallRecovery(supabase: AlertClient): Promise<{
  httpStatus: number;
  body: RecoveryRunBody;
}> {
  const [sessionsRes, alertsRes, receivablesRes] = await Promise.all([
    supabase
      .from("payment_sessions")
      .select("id, trip_id, provider_order_id, status, provider_state, created_at, captured_amount_pence, metadata")
      .not("metadata->shortfall_pence", "is", null)
      .order("created_at", { ascending: true })
      .limit(BATCH),
    supabase
      .from("ops_alerts")
      .select("fingerprint, status, related_trip_id, metadata")
      .eq("status", "open")
      .like("fingerprint", "finance:shortfall_unrecorded:%")
      .limit(BATCH),
    supabase
      .from("customer_receivables")
      .select("source_trip_id")
      .limit(5000),
  ]);

  const readError = sessionsRes.error ?? alertsRes.error ?? receivablesRes.error;
  if (readError) {
    const alert = await raiseRecoveryJobAlert(
      supabase,
      `Recovery could not read its inputs: ${readError.message ?? "unknown"}`,
    );
    return {
      httpStatus: 500,
      body: {
        ok: false,
        error: readError.message ?? "read_failed",
        money_moved: false,
        provider_called: false,
        alert,
      },
    };
  }

  const candidates = selectShortfallRecoveryCandidates({
    sessions: (sessionsRes.data ?? []) as Parameters<typeof selectShortfallRecoveryCandidates>[0]["sessions"],
    alerts: (alertsRes.data ?? []) as Parameters<typeof selectShortfallRecoveryCandidates>[0]["alerts"],
    receivableTripIds: ((receivablesRes.data ?? []) as Array<{ source_trip_id?: string | null }>)
      .map((row) => String(row.source_trip_id ?? ""))
      .filter(Boolean),
  }).slice(0, BATCH);

  const counts = {
    examined: candidates.length,
    receivable_recorded: 0,
    exception_recorded: 0,
    escalated: 0,
    not_required: 0,
    errors: 0,
  };

  for (const candidate of candidates) {
    try {
      let customerId = candidate.customerId;
      if (!customerId) {
        const { data: trip } = await supabase
          .from("trips")
          .select("passenger_id")
          .eq("id", candidate.tripId)
          .maybeSingle();
        customerId = (trip as { passenger_id?: string | null } | null)?.passenger_id
          ? String((trip as { passenger_id: string }).passenger_id)
          : null;
      }
      const outcome = await ensureShortfallReceivableOrException(supabase as never, {
        trip_id: candidate.tripId,
        payment_session_id: candidate.sessionId,
        provider_order_id: candidate.providerOrderId,
        customer_id: customerId,
        expected_fare_pence: candidate.expectedFarePence,
        captured_pence: candidate.capturedPence,
        shortfall_pence: candidate.shortfallPence,
        currency: candidate.currency,
        provider_state: "COMPLETED",
        source: candidate.source === "session_marker"
          ? "already_captured_retry"
          : "uncommitted_marker_alert",
      });
      if (outcome.state === SHORTFALL_SAFETY_STATE.RECEIVABLE_RECORDED) counts.receivable_recorded += 1;
      else if (outcome.state === SHORTFALL_SAFETY_STATE.EXCEPTION_RECORDED) counts.exception_recorded += 1;
      else if (outcome.state === SHORTFALL_SAFETY_STATE.ESCALATED_UNRECORDED) counts.escalated += 1;
      else counts.not_required += 1;
    } catch (err) {
      counts.errors += 1;
      console.error("[reconcile-waiting-shortfall-markers] candidate failed", candidate.tripId, err);
    }
  }

  let alert: RecoveryRunBody["alert"] = "none";
  if (counts.errors > 0) {
    alert = await raiseRecoveryJobAlert(
      supabase,
      `Recovery examined ${counts.examined} shortfalls and ${counts.errors} failed before they could be saved. No charge was made.`,
    );
  }

  return {
    httpStatus: 200,
    body: {
      ok: true,
      money_moved: false,
      provider_called: false,
      alert,
      ...counts,
    },
  };
}

