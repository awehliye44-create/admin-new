/**
 * Stage C2 hotfix SSOT — POST orchestration must never reference helper-locals
 * that exist only inside buildDriverWithdrawQuoteReadOnly (e.g. `summary`).
 * Service area is server-owned from the quote builder context.
 */

export const DRIVER_WITHDRAW_INTERNAL_ERROR = "INTERNAL_EXECUTION_ERROR" as const;
export const DRIVER_WITHDRAW_SERVICE_AREA_MISSING = "SERVICE_AREA_MISSING" as const;
export const DRIVER_WITHDRAW_SERVICE_AREA_MISMATCH = "SERVICE_AREA_MISMATCH" as const;
export const DRIVER_WITHDRAW_CLIENT_SERVICE_AREA_REJECTED =
  "CLIENT_SERVICE_AREA_REJECTED" as const;
export const DRIVER_WITHDRAW_DRIVER_COLLECTED_REJECTED =
  "DRIVER_COLLECTED_REJECTED" as const;

export type DriverWithdrawPostStage =
  | "auth"
  | "quote_rebuilt"
  | "service_area_resolved"
  | "amount_validated"
  | "destination_validated"
  | "reservation"
  | "provider_boundary"
  | "finalized"
  | "failed_closed";

export type DriverWithdrawQuoteContext = {
  /** Authoritative service area from wallet summary SSOT for this driver. */
  service_area_id: string | null;
  /** Optional financial-model marker from summary / gate (PLATFORM_COLLECTED expected). */
  financial_model: string | null;
};

/**
 * Reject any client attempt to supply / override service_area_id.
 */
export function rejectClientServiceAreaOverride(
  body: Record<string, unknown>,
): { ok: true } | { ok: false; code: typeof DRIVER_WITHDRAW_CLIENT_SERVICE_AREA_REJECTED; copy: string } {
  if (
    body.service_area_id != null
    || body.serviceAreaId != null
    || body.p_service_area_id != null
  ) {
    return {
      ok: false,
      code: DRIVER_WITHDRAW_CLIENT_SERVICE_AREA_REJECTED,
      copy: "Withdrawal service area cannot be supplied by the client.",
    };
  }
  return { ok: true };
}

/**
 * Resolve and verify service_area_id from the quote builder context.
 * No second wallet-summary RPC — uses the summary fields already loaded.
 * Membership check uses driver.service_area_id and/or driver_service_areas ids
 * already fetched alongside the quote context (no unrelated SA query for finance).
 */
export function resolveAuthoritativeWithdrawServiceArea(args: {
  summary_service_area_id: unknown;
  driver_primary_service_area_id: unknown;
  driver_membership_service_area_ids: readonly unknown[];
  financial_model?: unknown;
}):
  | {
    ok: true;
    service_area_id: string;
    financial_model: string | null;
  }
  | {
    ok: false;
    code:
      | typeof DRIVER_WITHDRAW_SERVICE_AREA_MISSING
      | typeof DRIVER_WITHDRAW_SERVICE_AREA_MISMATCH
      | typeof DRIVER_WITHDRAW_DRIVER_COLLECTED_REJECTED;
    copy: string;
  } {
  const model = String(args.financial_model ?? "").trim().toUpperCase();
  if (model === "DRIVER_COLLECTED") {
    return {
      ok: false,
      code: DRIVER_WITHDRAW_DRIVER_COLLECTED_REJECTED,
      copy: "Withdrawals are only available for platform-collected wallets.",
    };
  }

  const fromSummary = normalizeUuid(args.summary_service_area_id);
  if (!fromSummary) {
    return {
      ok: false,
      code: DRIVER_WITHDRAW_SERVICE_AREA_MISSING,
      copy: "Withdrawal service area could not be resolved.",
    };
  }

  const primary = normalizeUuid(args.driver_primary_service_area_id);
  const membership = new Set(
    (args.driver_membership_service_area_ids ?? [])
      .map(normalizeUuid)
      .filter((x): x is string => Boolean(x)),
  );
  if (primary) membership.add(primary);

  if (membership.size > 0 && !membership.has(fromSummary)) {
    return {
      ok: false,
      code: DRIVER_WITHDRAW_SERVICE_AREA_MISMATCH,
      copy: "Withdrawal service area does not match this driver.",
    };
  }

  return {
    ok: true,
    service_area_id: fromSummary,
    financial_model: model || null,
  };
}

export function normalizeUuid(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(s)
  ) {
    return null;
  }
  return s.toLowerCase();
}

/** FNV-1a 32-bit hex — diagnostics only; not a secret hash. */
export function hashIdempotencyKeyForDiagnostics(raw: string): string {
  let h = 0x811c9dc5;
  const s = String(raw ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ("00000000" + (h >>> 0).toString(16)).slice(-8);
}

export type DriverWithdrawDiag = {
  request_id: string;
  idempotency_key_hash: string | null;
  driver_id: string | null;
  stage: DriverWithdrawPostStage;
  quote_version: string | null;
  gross_pence: number | null;
  fee_pence: number | null;
  net_pence: number | null;
  service_area_id: string | null;
  reservation_ok: boolean | null;
  provider_boundary_reached: boolean;
  final_status: string | null;
  error_code: string | null;
};

export function buildDriverWithdrawDiag(
  partial: Partial<DriverWithdrawDiag> & { request_id: string },
): DriverWithdrawDiag {
  return {
    request_id: partial.request_id,
    idempotency_key_hash: partial.idempotency_key_hash ?? null,
    driver_id: partial.driver_id ?? null,
    stage: partial.stage ?? "auth",
    quote_version: partial.quote_version ?? null,
    gross_pence: partial.gross_pence ?? null,
    fee_pence: partial.fee_pence ?? null,
    net_pence: partial.net_pence ?? null,
    service_area_id: partial.service_area_id ?? null,
    reservation_ok: partial.reservation_ok ?? null,
    provider_boundary_reached: partial.provider_boundary_reached ?? false,
    final_status: partial.final_status ?? null,
    error_code: partial.error_code ?? null,
  };
}

export function safeDriverWithdrawInternalErrorBody(args: {
  request_id: string;
  diag?: DriverWithdrawDiag | null;
}): Record<string, unknown> {
  return {
    ok: false,
    error: DRIVER_WITHDRAW_INTERNAL_ERROR,
    error_code: DRIVER_WITHDRAW_INTERNAL_ERROR,
    driver_message: "Withdrawal could not be completed. Please try again shortly.",
    revolut_pay_called: false,
    writes: false,
    request_id: args.request_id,
    diagnostics: args.diag
      ? {
        request_id: args.diag.request_id,
        stage: args.diag.stage,
        error_code: DRIVER_WITHDRAW_INTERNAL_ERROR,
        provider_boundary_reached: false,
      }
      : { request_id: args.request_id, stage: "failed_closed" },
  };
}
