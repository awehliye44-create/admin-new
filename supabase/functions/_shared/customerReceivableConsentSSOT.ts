/**
 * Customer receivable fold consent — fail-closed SSOT.
 *
 * Invariant: NO_VISIBLE_CONSENT → NO_RECEIVABLE_FOLD (old clients).
 *
 * RECEIVABLE_EXPECTED (consent/UI implies debt in the payable total):
 *   gate OFF / not allowlisted / mismatch / reserve failure → typed fail-closed.
 *   Never silently continue fare-only (MK-260924-002).
 *
 * Fold when admitted requires:
 *   1) server feature gate ON (default OFF)
 *   2) optional customer allowlist (when configured)
 *   3) customer_receivable_consent_version === 1
 *   4) displayed outstanding matches re-read OPEN outstanding
 *   5) quote version matches outstanding:<pence>:v1 (when provided)
 *   6) displayed total authorisation matches server fare + buffer + outstanding
 *
 * Gate is read once per request and frozen on the decision — never re-read
 * mid-request after admission.
 */
export const CUSTOMER_RECEIVABLE_CONSENT_VERSION = 1 as const;

export const RECEIVABLE_FOLD_SKIPPED_COMPAT = "RECEIVABLE_FOLD_SKIPPED_COMPAT" as const;
export const RECEIVABLE_CONSENT_REFRESH_REQUIRED =
  "RECEIVABLE_CONSENT_REFRESH_REQUIRED" as const;
export const RECEIVABLE_FOLD_GATE_OFF = "RECEIVABLE_FOLD_GATE_OFF" as const;
/** Gate/allowlist blocks a request that already consented to fold debt into pay. */
export const RECEIVABLE_FOLD_UNAVAILABLE = "RECEIVABLE_FOLD_UNAVAILABLE" as const;

export type ReceivableConsentRequest = {
  customer_receivable_consent_version?: number | null;
  /** Outstanding total the client displayed when Book was pressed. */
  customer_receivable_displayed_outstanding_pence?: number | null;
  /** Optional quote id / fingerprint from outstanding summary fetch. */
  customer_receivable_quote_version?: string | null;
  /** Trip fare the client displayed (must remain separate from debt). */
  customer_receivable_displayed_trip_fare_pence?: number | null;
  /** Total authorisation the client showed on the Book CTA. */
  customer_receivable_displayed_total_authorisation_pence?: number | null;
};

export type ReceivableFoldConsentDecision =
  | {
    allow_fold: false;
    receivable_expected: boolean;
    reason:
      | typeof RECEIVABLE_FOLD_GATE_OFF
      | typeof RECEIVABLE_FOLD_SKIPPED_COMPAT
      | "not_on_allowlist"
      | "missing_customer_id";
    telemetry: Record<string, unknown>;
  }
  | {
    allow_fold: true;
    receivable_expected: boolean;
    reason: "consent_matched";
    /** Frozen at decision time — do not re-read global gate later. */
    admission_frozen: true;
    gate_enabled_at_admission: boolean;
    displayed_outstanding_pence: number;
    quote_version: string | null;
    displayed_trip_fare_pence: number | null;
    displayed_total_authorisation_pence: number | null;
    telemetry: Record<string, unknown>;
  }
  | {
    allow_fold: false;
    fail_closed: true;
    receivable_expected: boolean;
    reason:
      | typeof RECEIVABLE_CONSENT_REFRESH_REQUIRED
      | typeof RECEIVABLE_FOLD_UNAVAILABLE;
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

/** Expected quote fingerprint for a given OPEN outstanding total. */
export function buildServerReceivableQuoteVersion(outstanding_pence: number): string {
  return `outstanding:${nonNegPence(outstanding_pence)}:v${CUSTOMER_RECEIVABLE_CONSENT_VERSION}`;
}

/** Parse `outstanding:<pence>:v1` → pence, or null if not that shape. */
export function parseOutstandingPenceFromQuoteVersion(
  quote_version: string | null | undefined,
): number | null {
  const raw = String(quote_version ?? "").trim();
  const m = /^outstanding:(\d+):v\d+$/i.exec(raw);
  if (!m) return null;
  return nonNegPence(m[1]);
}

/**
 * True when the client request/UI implies debt is part of the payable total.
 * Old apps with no consent fields → false → fare-only compat allowed.
 */
export function classifyReceivableExpectedRequest(
  consent?: ReceivableConsentRequest | null,
): {
  receivable_expected: boolean;
  displayed_outstanding_pence: number;
  displayed_trip_fare_pence: number | null;
  displayed_total_authorisation_pence: number | null;
  quote_outstanding_pence: number | null;
  reason:
    | "consent_outstanding_positive"
    | "displayed_total_exceeds_trip_fare"
    | "quote_outstanding_positive"
    | "not_expected";
} {
  const c = consent ?? {};
  const displayed = nonNegPence(c.customer_receivable_displayed_outstanding_pence);
  const tripFare = c.customer_receivable_displayed_trip_fare_pence != null
    ? nonNegPence(c.customer_receivable_displayed_trip_fare_pence)
    : null;
  const total = c.customer_receivable_displayed_total_authorisation_pence != null
    ? nonNegPence(c.customer_receivable_displayed_total_authorisation_pence)
    : null;
  const quoteOutstanding = parseOutstandingPenceFromQuoteVersion(
    c.customer_receivable_quote_version,
  );

  if (displayed > 0) {
    return {
      receivable_expected: true,
      displayed_outstanding_pence: displayed,
      displayed_trip_fare_pence: tripFare,
      displayed_total_authorisation_pence: total,
      quote_outstanding_pence: quoteOutstanding,
      reason: "consent_outstanding_positive",
    };
  }
  if (total != null && tripFare != null && total > tripFare) {
    return {
      receivable_expected: true,
      displayed_outstanding_pence: displayed,
      displayed_trip_fare_pence: tripFare,
      displayed_total_authorisation_pence: total,
      quote_outstanding_pence: quoteOutstanding,
      reason: "displayed_total_exceeds_trip_fare",
    };
  }
  if (quoteOutstanding != null && quoteOutstanding > 0) {
    return {
      receivable_expected: true,
      displayed_outstanding_pence: displayed,
      displayed_trip_fare_pence: tripFare,
      displayed_total_authorisation_pence: total,
      quote_outstanding_pence: quoteOutstanding,
      reason: "quote_outstanding_positive",
    };
  }
  return {
    receivable_expected: false,
    displayed_outstanding_pence: displayed,
    displayed_trip_fare_pence: tripFare,
    displayed_total_authorisation_pence: total,
    quote_outstanding_pence: quoteOutstanding,
    reason: "not_expected",
  };
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
 * Choose Ride / quote endpoint: whether fold may be shown in the payable CTA.
 * Does not reserve — Book still runs full consent + reserve.
 */
export function planCustomerReceivableFoldEligibilityQuote(args: {
  customer_id?: string | null;
  server_outstanding_pence: number;
  trip_fare_pence: number;
  buffer_pence?: number | null;
  gate?: { enabled: boolean; allowlist: Set<string> };
}): {
  outstanding_pence: number;
  fold_eligible: boolean;
  quote_version: string;
  trip_fare_pence: number;
  buffer_pence: number;
  total_authorisation_pence: number;
  consent_version: typeof CUSTOMER_RECEIVABLE_CONSENT_VERSION;
  reason: string;
} {
  const outstanding = nonNegPence(args.server_outstanding_pence);
  const trip = nonNegPence(args.trip_fare_pence);
  const buffer = nonNegPence(args.buffer_pence);
  const gate = args.gate ?? readCustomerReceivableFoldGate();
  const customerId = String(args.customer_id ?? "").trim();
  const quote_version = buildServerReceivableQuoteVersion(outstanding);

  let fold_eligible = false;
  let reason = "fold_disabled";
  if (outstanding <= 0) {
    reason = "no_open_receivables";
  } else if (!customerId) {
    reason = "missing_customer_id";
  } else if (!gate.enabled) {
    reason = RECEIVABLE_FOLD_GATE_OFF;
  } else if (gate.allowlist.size > 0 && !gate.allowlist.has(customerId)) {
    reason = "not_on_allowlist";
  } else {
    fold_eligible = true;
    reason = "fold_eligible";
  }

  const total_authorisation_pence = fold_eligible
    ? trip + buffer + outstanding
    : trip + buffer;

  return {
    outstanding_pence: outstanding,
    fold_eligible,
    quote_version,
    trip_fare_pence: trip,
    buffer_pence: buffer,
    total_authorisation_pence,
    consent_version: CUSTOMER_RECEIVABLE_CONSENT_VERSION,
    reason,
  };
}

/**
 * Decide whether reserve/fold may run for this preauth request.
 * Call AFTER eligibility (platform/personal) and BEFORE reserve RPC.
 * Pass a frozen `gate` snapshot — never re-read Deno.env after admission.
 */
export function planCustomerReceivableFoldConsent(args: {
  customer_id?: string | null;
  consent?: ReceivableConsentRequest | null;
  server_outstanding_pence: number;
  server_ride_fare_pence?: number | null;
  server_buffer_pence?: number | null;
  gate?: { enabled: boolean; allowlist: Set<string> };
}): ReceivableFoldConsentDecision {
  const customerId = String(args.customer_id ?? "").trim();
  const gate = args.gate ?? readCustomerReceivableFoldGate();
  const consent = args.consent ?? {};
  const expected = classifyReceivableExpectedRequest(consent);
  const version = Number(consent.customer_receivable_consent_version ?? 0);
  const displayed = expected.displayed_outstanding_pence;
  const quoteVersion = consent.customer_receivable_quote_version
    ? String(consent.customer_receivable_quote_version).trim() || null
    : null;
  const displayedTripFare = expected.displayed_trip_fare_pence;
  const displayedTotal = expected.displayed_total_authorisation_pence;
  const serverOutstanding = nonNegPence(args.server_outstanding_pence);
  const serverRide = args.server_ride_fare_pence != null
    ? nonNegPence(args.server_ride_fare_pence)
    : null;
  const serverBuffer = nonNegPence(args.server_buffer_pence);
  const expectedQuote = buildServerReceivableQuoteVersion(serverOutstanding);
  const serverTotal = serverRide != null
    ? serverRide + serverBuffer + serverOutstanding
    : null;

  const baseTelemetry = {
    customer_id: customerId || null,
    gate_enabled: gate.enabled,
    consent_version: version || null,
    receivable_expected: expected.receivable_expected,
    receivable_expected_reason: expected.reason,
    displayed_outstanding_pence: displayed,
    server_outstanding_pence: serverOutstanding,
    quote_version: quoteVersion,
    expected_quote_version: expectedQuote,
    displayed_trip_fare_pence: displayedTripFare,
    displayed_total_authorisation_pence: displayedTotal,
    server_ride_fare_pence: serverRide,
    server_buffer_pence: serverBuffer,
    server_total_authorisation_pence: serverTotal,
  };

  const failUnavailable = (note: string): ReceivableFoldConsentDecision => ({
    allow_fold: false,
    fail_closed: true,
    receivable_expected: true,
    reason: RECEIVABLE_FOLD_UNAVAILABLE,
    server_outstanding_pence: serverOutstanding,
    displayed_outstanding_pence: displayed,
    telemetry: {
      ...baseTelemetry,
      event: RECEIVABLE_FOLD_UNAVAILABLE,
      note,
    },
  });

  const failRefresh = (note: string): ReceivableFoldConsentDecision => ({
    allow_fold: false,
    fail_closed: true,
    receivable_expected: expected.receivable_expected,
    reason: RECEIVABLE_CONSENT_REFRESH_REQUIRED,
    server_outstanding_pence: serverOutstanding,
    displayed_outstanding_pence: displayed,
    telemetry: {
      ...baseTelemetry,
      event: RECEIVABLE_CONSENT_REFRESH_REQUIRED,
      note,
    },
  });

  if (!customerId) {
    if (expected.receivable_expected) {
      return failUnavailable("missing_customer_id_receivable_expected");
    }
    return {
      allow_fold: false,
      receivable_expected: false,
      reason: "missing_customer_id",
      telemetry: { ...baseTelemetry, event: RECEIVABLE_FOLD_SKIPPED_COMPAT },
    };
  }

  // ── RECEIVABLE_EXPECTED: never fare-only ─────────────────────────────
  if (expected.receivable_expected) {
    if (!gate.enabled) {
      return failUnavailable("fold_disabled_receivable_expected");
    }
    if (gate.allowlist.size > 0 && !gate.allowlist.has(customerId)) {
      return failUnavailable("customer_not_on_fold_allowlist");
    }
    if (version !== CUSTOMER_RECEIVABLE_CONSENT_VERSION) {
      return failUnavailable("missing_or_unsupported_consent_version");
    }
    if (serverOutstanding > 0 && displayed !== serverOutstanding) {
      return failRefresh("displayed_outstanding_mismatch");
    }
    if (displayed > 0 && serverOutstanding === 0) {
      return failRefresh("server_outstanding_cleared");
    }
    if (quoteVersion && quoteVersion !== expectedQuote) {
      return failRefresh("quote_version_mismatch");
    }
    if (
      displayedTripFare != null
      && serverRide != null
      && displayedTripFare !== serverRide
    ) {
      return failRefresh("displayed_trip_fare_mismatch");
    }
    if (
      displayedTotal != null
      && serverTotal != null
      && displayedTotal !== serverTotal
    ) {
      return failRefresh("displayed_total_authorisation_mismatch");
    }

    return {
      allow_fold: true,
      receivable_expected: true,
      reason: "consent_matched",
      admission_frozen: true,
      gate_enabled_at_admission: gate.enabled,
      displayed_outstanding_pence: displayed,
      quote_version: quoteVersion,
      displayed_trip_fare_pence: displayedTripFare,
      displayed_total_authorisation_pence: displayedTotal,
      telemetry: {
        ...baseTelemetry,
        event: "RECEIVABLE_FOLD_CONSENT_MATCHED",
        admission_frozen: true,
      },
    };
  }

  // ── Not expected (old client / no debt in CTA) — compat fare-only OK ─
  if (!gate.enabled) {
    return {
      allow_fold: false,
      receivable_expected: false,
      reason: RECEIVABLE_FOLD_GATE_OFF,
      telemetry: {
        ...baseTelemetry,
        event: RECEIVABLE_FOLD_GATE_OFF,
        note: "fold_disabled_default_off_compat",
      },
    };
  }

  if (gate.allowlist.size > 0 && !gate.allowlist.has(customerId)) {
    return {
      allow_fold: false,
      receivable_expected: false,
      reason: "not_on_allowlist",
      telemetry: {
        ...baseTelemetry,
        event: RECEIVABLE_FOLD_SKIPPED_COMPAT,
        note: "customer_not_on_fold_allowlist",
      },
    };
  }

  if (version !== CUSTOMER_RECEIVABLE_CONSENT_VERSION) {
    return {
      allow_fold: false,
      receivable_expected: false,
      reason: RECEIVABLE_FOLD_SKIPPED_COMPAT,
      telemetry: {
        ...baseTelemetry,
        event: RECEIVABLE_FOLD_SKIPPED_COMPAT,
        note: "missing_or_unsupported_consent_version",
      },
    };
  }

  // Compatible client with version but zero displayed debt — no-op fold OK.
  if (serverOutstanding > 0 && displayed !== serverOutstanding) {
    return failRefresh("displayed_outstanding_mismatch");
  }
  if (quoteVersion && quoteVersion !== expectedQuote) {
    return failRefresh("quote_version_mismatch");
  }
  if (
    displayedTripFare != null
    && serverRide != null
    && displayedTripFare !== serverRide
  ) {
    return failRefresh("displayed_trip_fare_mismatch");
  }
  if (
    displayedTotal != null
    && serverTotal != null
    && displayedTotal !== serverTotal
  ) {
    return failRefresh("displayed_total_authorisation_mismatch");
  }

  return {
    allow_fold: true,
    receivable_expected: false,
    reason: "consent_matched",
    admission_frozen: true,
    gate_enabled_at_admission: gate.enabled,
    displayed_outstanding_pence: displayed,
    quote_version: quoteVersion,
    displayed_trip_fare_pence: displayedTripFare,
    displayed_total_authorisation_pence: displayedTotal,
    telemetry: {
      ...baseTelemetry,
      event: "RECEIVABLE_FOLD_CONSENT_MATCHED",
      admission_frozen: true,
    },
  };
}

/**
 * After durable reserve: if the reserved fold total differs from the CTA
 * amount the customer saw, fail closed — never call the provider with a
 * silently updated amount.
 */
export function planReceivableReservedTotalMatchesConsent(args: {
  reserved_authorised_amount_pence: number;
  displayed_total_authorisation_pence?: number | null;
}): {
  ok: true;
} | {
  ok: false;
  fail_closed: true;
  reason: typeof RECEIVABLE_CONSENT_REFRESH_REQUIRED;
  telemetry: Record<string, unknown>;
} {
  const reserved = nonNegPence(args.reserved_authorised_amount_pence);
  if (args.displayed_total_authorisation_pence == null) {
    return { ok: true };
  }
  const displayed = nonNegPence(args.displayed_total_authorisation_pence);
  if (displayed === reserved) return { ok: true };
  return {
    ok: false,
    fail_closed: true,
    reason: RECEIVABLE_CONSENT_REFRESH_REQUIRED,
    telemetry: {
      event: RECEIVABLE_CONSENT_REFRESH_REQUIRED,
      note: "reserved_total_mismatch_after_reserve",
      displayed_total_authorisation_pence: displayed,
      reserved_authorised_amount_pence: reserved,
    },
  };
}

/** Canonical fields returned on successful / failed fold-aware preauth. */
export function buildReceivablePreauthResponseFields(args: {
  trip_fare_pence: number;
  receivable_reserved_pence: number;
  total_authorisation_pence: number;
  consent_version?: number | null;
  quote_version?: string | null;
  fold_admission?: string | null;
  fold_result?: string | null;
}): Record<string, unknown> {
  return {
    trip_fare_pence: nonNegPence(args.trip_fare_pence),
    receivable_reserved_pence: nonNegPence(args.receivable_reserved_pence),
    total_authorisation_pence: nonNegPence(args.total_authorisation_pence),
    customer_receivable_consent_version:
      args.consent_version ?? CUSTOMER_RECEIVABLE_CONSENT_VERSION,
    customer_receivable_quote_version: args.quote_version ?? null,
    receivable_fold_admission: args.fold_admission ?? null,
    receivable_fold_result: args.fold_result ?? null,
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
    customer_receivable_displayed_trip_fare_pence: pick(
      "customer_receivable_displayed_trip_fare_pence",
    ) as number | null,
    customer_receivable_displayed_total_authorisation_pence: pick(
      "customer_receivable_displayed_total_authorisation_pence",
    ) as number | null,
  };
}
