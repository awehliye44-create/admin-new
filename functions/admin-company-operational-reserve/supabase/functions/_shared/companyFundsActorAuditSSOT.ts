/**
 * Company funds mutation audit envelope — actor + before/after without secrets.
 */
export type CompanyFundsActorAuditContext = {
  actor_user_id: string | null;
  actor_email: string | null;
  actor_role: string | null;
  actor_is_owner: boolean;
  auth_source?: string | null;
};

export function buildCompanyFundsAuditEnvelope(args: {
  actor: CompanyFundsActorAuditContext;
  action: string;
  before_state?: Record<string, unknown> | null;
  after_state?: Record<string, unknown> | null;
  reason?: string | null;
  note?: string | null;
  request_id?: string | null;
  idempotency_key?: string | null;
  extra?: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    action: args.action,
    actor_user_id: args.actor.actor_user_id,
    actor_email: args.actor.actor_email,
    actor_role: args.actor.actor_role,
    actor_is_owner: args.actor.actor_is_owner === true,
    auth_source: args.actor.auth_source ?? null,
    before_state: args.before_state ?? null,
    after_state: args.after_state ?? null,
    reason: args.reason ?? null,
    note: args.note ?? null,
    request_id: args.request_id ?? null,
    idempotency_key: args.idempotency_key ?? null,
    recorded_at: new Date().toISOString(),
    ...(args.extra ?? {}),
  };
}

export function redactCompanyFundsAuditState(
  state: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!state) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    const k = key.toLowerCase();
    if (
      k.includes("account_number")
      || k.includes("iban")
      || k.includes("sort_code")
      || k.includes("secret")
      || k.includes("token")
      || k.includes("api_key")
    ) {
      continue;
    }
    if (k.includes("masked") || k.endsWith("_last4") || k.includes("display_name")) {
      out[key] = value;
      continue;
    }
    if (typeof value === "string" && value.length > 240) {
      out[key] = `${value.slice(0, 237)}…`;
      continue;
    }
    out[key] = value;
  }
  return out;
}
