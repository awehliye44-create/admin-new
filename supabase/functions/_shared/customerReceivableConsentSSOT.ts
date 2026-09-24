/**
 * Customer receivable fold consent — fail-closed SSOT.
 *
 * Invariant: NO_VISIBLE_CONSENT → NO_RECEIVABLE_FOLD
 *
 * Old Customer apps (no capability) must never silently fold historical debt
 * into preauth. Fold requires:
 *   1) server feature gate ON (default OFF)
 *   2) optional customer allowlist (when configured)
 *   3) customer_receivable_consent_version === 1
 *   4) displayed quote pence matches re-read OPEN outstanding
 *
 * Amount mismatch → typed refresh-required (never charge).
 */
export const CUSTOMER_RECEIVABLE_CONSENT_VERSION = 1 as const;

export const RECEIVABLE_FOLD_SKIPPED_COMPAT = "RECEIVABLE_FOLD_SKIPPED_COMPAT" as const;
export const RECEIVABLE_CONSENT_REFRESH_REQUIRED =
  "RECEIVABLE_CONSENT_REFRESH_REQUIRED" as const;
export const RECEIVABLE_FOLD_GATE_OFF = "RECEIVABLE_FOLD_GATE_OFF" as const;

export type ReceivableConsentRequest = {
  customer_receivable_consent_version?: number | null;
  /** Outstanding total the client displayed when Book was pressed. */
  customer_receivable_displayed_outstanding_pence?: number | null;
  /** Optional quote id / fingerprint from outstanding summary fetch. */
  customer_receivable_quote_version?: string | null;
};

export type ReceivableFoldConsentDecision =
  | {
    allow_fold: false;
    reason:
      | typeof RECEIVABLE_FOLD_GATE_OFF
      | typeof RECEIVABLE_FOLD_SKIPPED_COMPAT
      | "not_on_allowlist"
      | "missing_customer_id";
    telemetry: Record<string, unknown>;
  }
  | {
    allow_fold: true;
    reason: "consent_matched";
    displayed_outstanding_pence: number;
    quote_version: string | null;
    telemetry: Record<string, unknown>;
  }
  | {
    allow_fold: false;
    fail_closed: true;
    reason: typeof RECEIVABLE_CONSENT_REFRESH_REQUIRED;
    server_outstanding_pence: number;
    displayed_outstanding_pence: number;
    telemetry: Record<string, unknown>;
  };

function parseBoolEnv(raw: string | undefined | null, defaultValue: boolean): boolean {
  if (raw == null || String(raw).trim() === "") return defaultValue;
  const v = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return defaultValue;
}

function parseAllowlist(raw: string | undefined | null): Set<string> {
  const set = new Set<string>();
  for (const part of String(raw ?? "").split(/[,\s]+/)) {
    const id = part.trim();
    if (id) set.add(id);
  }
  return set;
}

function nonNegPence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

/**
 * Server feature gate — DEFAULT OFF until compatible Customer build is installed.
 * Env: CUSTOMER_RECEIVABLE_FOLD_ENABLED=true to enable.
 * Optional allowlist: CUSTOMER_RECEIVABLE_FOLD_CUSTOMER_ALLOWLIST=uuid,uuid
 */
export function readCustomerReceivableFoldGate(env?: {
  CUSTOMER_RECEIVABLE_FOLD_ENABLED?: string | null;
  CUSTOMER_RECEIVABLE_FOLD_CUSTOMER_ALLOWLIST?: string | null;
}): {
  enabled: boolean;
  allowlist: Set<string>;
} {
  const fromArg = env != null;
  const enabledRaw = fromArg
    ? env.CUSTOMER_RECEIVABLE_FOLD_ENABLED
    : (typeof Deno !== "undefined"
      ? Deno.env.get("CUSTOMER_RECEIVABLE_FOLD_ENABLED")
      : undefined);
  const allowRaw = fromArg
    ? env.CUSTOMER_RECEIVABLE_FOLD_CUSTOMER_ALLOWLIST
    : (typeof Deno !== "undefined"
      ? Deno.env.get("CUSTOMER_RECEIVABLE_FOLD_CUSTOMER_ALLOWLIST")
      : undefined);
  return {
    enabled: parseBoolEnv(enabledRaw, false),
    allowlist: parseAllowlist(allowRaw),
  };
}

/**
 * Decide whether reserve/fold may run for this preauth request.
 * Call AFTER eligibility (platform/personal) and BEFORE reserve RPC.
 * `server_outstanding_pence` must come from a fresh OPEN-receivables read
 * under the same reservation lock path (or immediately before reserve).
 */
export function planCustomerReceivableFoldConsent(args: {
  customer_id?: string | null;
  consent?: ReceivableConsentRequest | null;
  server_outstanding_pence: number;
  gate?: { enabled: boolean; allowlist: Set<string> };
}): ReceivableFoldConsentDecision {
  const customerId = String(args.customer_id ?? "").trim();
  const gate = args.gate ?? readCustomerReceivableFoldGate();
  const consent = args.consent ?? {};
  const version = Number(args.consent?.customer_receivable_consent_version ?? 0);
  const displayed = nonNegPence(
    consent.customer_receivable_displayed_outstanding_pence,
  );
  const quoteVersion = consent.customer_receivable_quote_version
    ? String(consent.customer_receivable_quote_version).trim() || null
    : null;
  const serverOutstanding = nonNegPence(args.server_outstanding_pence);

  const baseTelemetry = {
    customer_id: customerId || null,
    gate_enabled: gate.enabled,
    consent_version: version || null,
    displayed_outstanding_pence: displayed,
    server_outstanding_pence: serverOutstanding,
    quote_version: quoteVersion,
  };

  if (!customerId) {
    return {
      allow_fold: false,
      reason: "missing_customer_id",
      telemetry: { ...baseTelemetry, event: RECEIVABLE_FOLD_SKIPPED_COMPAT },
    };
  }

  if (!gate.enabled) {
    return {
      allow_fold: false,
      reason: RECEIVABLE_FOLD_GATE_OFF,
      telemetry: {
        ...baseTelemetry,
        event: RECEIVABLE_FOLD_GATE_OFF,
        note: "fold_disabled_default_off",
      },
    };
  }

  if (gate.allowlist.size > 0 && !gate.allowlist.has(customerId)) {
    return {
      allow_fold: false,
      reason: "not_on_allowlist",
      telemetry: {
        ...baseTelemetry,
        event: RECEIVABLE_FOLD_SKIPPED_COMPAT,
        note: "customer_not_on_fold_allowlist",
      },
    };
  }

  // Old app / missing capability — never fold.
  if (version !== CUSTOMER_RECEIVABLE_CONSENT_VERSION) {
    return {
      allow_fold: false,
      reason: RECEIVABLE_FOLD_SKIPPED_COMPAT,
      telemetry: {
        ...baseTelemetry,
        event: RECEIVABLE_FOLD_SKIPPED_COMPAT,
        note: "missing_or_unsupported_consent_version",
      },
    };
  }

  // Visible consent required when server has OPEN debt.
  // Client must have displayed the same outstanding total.
  if (serverOutstanding > 0 && displayed !== serverOutstanding) {
    return {
      allow_fold: false,
      fail_closed: true,
      reason: RECEIVABLE_CONSENT_REFRESH_REQUIRED,
      server_outstanding_pence: serverOutstanding,
      displayed_outstanding_pence: displayed,
      telemetry: {
        ...baseTelemetry,
        event: RECEIVABLE_CONSENT_REFRESH_REQUIRED,
        note: "displayed_outstanding_mismatch",
      },
    };
  }

  return {
    allow_fold: true,
    reason: "consent_matched",
    displayed_outstanding_pence: displayed,
    quote_version: quoteVersion,
    telemetry: {
      ...baseTelemetry,
      event: "RECEIVABLE_FOLD_CONSENT_MATCHED",
    },
  };
}

/** Extract consent fields from preauth body / metadata / booking snapshot. */
export function extractReceivableConsentFromPreauthBody(
  body: Record<string, unknown> | null | undefined,
): ReceivableConsentRequest {
  const b = body ?? {};
  const meta =
    b.metadata && typeof b.metadata === "object"
      ? b.metadata as Record<string, unknown>
      : {};
  const snap =
    b.booking_snapshot && typeof b.booking_snapshot === "object"
      ? b.booking_snapshot as Record<string, unknown>
      : {};
  const pick = (k: string): unknown =>
    b[k] ?? meta[k] ?? snap[k] ?? null;
  return {
    customer_receivable_consent_version: pick(
      "customer_receivable_consent_version",
    ) as number | null,
    customer_receivable_displayed_outstanding_pence: pick(
      "customer_receivable_displayed_outstanding_pence",
    ) as number | null,
    customer_receivable_quote_version: pick(
      "customer_receivable_quote_version",
    ) as string | null,
  };
}
