/**
 * Bug #37 — deduplicated Google Pay health alerts via existing ops_alerts.
 */

export type GooglePayOpsAlertInput = {
  fingerprint: string;
  title: string;
  description?: string | null;
  severity?: "info" | "warning" | "critical";
  related_payment_session_id?: string | null;
  metadata?: Record<string, unknown>;
};

export function buildGooglePayOpsAlertRow(
  input: GooglePayOpsAlertInput,
  nowIso: string = new Date().toISOString(),
): Record<string, unknown> {
  return {
    fingerprint: input.fingerprint,
    category: "payments_google_pay",
    severity: input.severity ?? "warning",
    status: "open",
    source: "edge_function",
    app: "backend",
    title: input.title,
    description: input.description ?? null,
    related_entity_type: input.related_payment_session_id ? "payment_session" : null,
    related_entity_id: input.related_payment_session_id ?? null,
    related_payment_id: null,
    metadata: {
      ...(input.metadata ?? {}),
      payment_session_id: input.related_payment_session_id ?? null,
    },
    last_detected_at: nowIso,
    updated_at: nowIso,
  };
}

type SupabaseLike = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        in: (col: string, vals: string[]) => {
          maybeSingle: () => Promise<{
            data: { id: string; fingerprint_count?: number } | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
    update: (row: Record<string, unknown>) => {
      eq: (col: string, val: string) => Promise<{ error: { message: string } | null }>;
    };
    insert: (row: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
  };
};

/** Best-effort dedupe upsert on open fingerprint. Never throws into payment path. */
export async function upsertGooglePayOpsAlert(
  supabase: SupabaseLike,
  input: GooglePayOpsAlertInput,
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const row = buildGooglePayOpsAlertRow(input, nowIso);
  try {
    const { data: existing, error: selErr } = await supabase
      .from("ops_alerts")
      .select("id, fingerprint_count")
      .eq("fingerprint", input.fingerprint)
      .in("status", ["open", "acknowledged"])
      .maybeSingle();
    if (!selErr && existing?.id) {
      const nextCount = Math.max(1, Number(existing.fingerprint_count) || 1) + 1;
      const { error: updErr } = await supabase
        .from("ops_alerts")
        .update({
          title: row.title,
          description: row.description,
          severity: row.severity,
          metadata: row.metadata,
          related_entity_type: row.related_entity_type,
          related_entity_id: row.related_entity_id,
          fingerprint_count: nextCount,
          last_detected_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", existing.id);
      return !updErr;
    }
    const { error: insertErr } = await supabase.from("ops_alerts").insert(row);
    return !insertErr;
  } catch {
    return false;
  }
}

export function googlePayFailureFingerprint(args: {
  customer_code: string;
  revolut_error_code?: string | null;
}): string {
  const code = String(args.customer_code || "GOOGLE_PAY_SUBMIT_FAILED").trim();
  const revolut = String(args.revolut_error_code ?? "none").trim() || "none";
  return `gpay_submit:${code}:${revolut}`;
}
