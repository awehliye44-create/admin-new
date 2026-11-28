/** Offline test/audit-only helpers; not part of Edge uploads. */
import { ModificationHoldLiveness } from "../../../functions/_shared/modificationHoldLivenessSSOT.ts";


export function classifyPaymentSessionHoldLiveness(args: {
  session: {
    id?: unknown;
    trip_id?: unknown;
    provider_state?: unknown;
    status?: unknown;
    hold_release_state?: unknown;
    released_at?: unknown;
    captured_at?: unknown;
    authorised_amount_pence?: unknown;
    total_authorised_amount_pence?: unknown;
    metadata?: unknown;
  } | null | undefined;
  expectedTripId: string;
  requiredPayablePence: number;
}): ModificationHoldLiveness {
  const session = args.session;
  if (!session?.id) {
    return { ok: false, code: "missing_session", authorisedPence: 0 };
  }
  const sessionId = String(session.id);
  const sessionTrip = String(session.trip_id ?? "").trim();
  if (sessionTrip && sessionTrip !== String(args.expectedTripId).trim()) {
    return { ok: false, code: "wrong_trip", authorisedPence: 0 };
  }

  const meta = session.metadata && typeof session.metadata === "object"
    ? session.metadata as Record<string, unknown>
    : {};
  if (String(meta.never_capture ?? "") === "true") {
    return { ok: false, code: "superseded", authorisedPence: 0 };
  }

  const hold = String(session.hold_release_state ?? "").toLowerCase();
  if (hold === "releasing") {
    return { ok: false, code: "releasing", authorisedPence: 0 };
  }
  if (hold === "released" || (session.released_at && !session.captured_at)) {
    return { ok: false, code: "released", authorisedPence: 0 };
  }

  const provider = String(session.provider_state ?? "").toUpperCase();
  if (["CANCELLED", "CANCELED", "FAILED", "DECLINED", "EXPIRED"].includes(provider)) {
    return {
      ok: false,
      code: provider === "EXPIRED" ? "expired" : "not_authorised",
      authorisedPence: 0,
    };
  }
  if (!["AUTHORISED", "AUTHORIZED", "COMPLETED"].includes(provider)) {
    return { ok: false, code: "not_authorised", authorisedPence: 0 };
  }

  const status = String(session.status ?? "").toLowerCase();
  if (
    [
      "cancelled",
      "canceled",
      "failed",
      "expired",
      "abandoned",
      "payment_orphaned",
      "released",
      "orphan_authorisation",
    ].includes(status)
  ) {
    return {
      ok: false,
      code: status === "expired" ? "expired" : "not_authorised",
      authorisedPence: 0,
    };
  }

  const authorisedPence = Math.max(
    0,
    Math.round(Number(session.total_authorised_amount_pence ?? 0)),
    Math.round(Number(session.authorised_amount_pence ?? 0)),
  );
  const required = Math.max(0, Math.round(Number(args.requiredPayablePence)));
  if (required > 0 && authorisedPence < required) {
    return { ok: false, code: "insufficient", authorisedPence };
  }
  return { ok: true, authorisedPence, sessionId };
}

export * from "../../../functions/_shared/modificationHoldLivenessSSOT.ts";
