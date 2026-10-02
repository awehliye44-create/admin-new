/**
 * Server-side Corporate booking authority.
 * Membership and organisation scope come from authenticated identity — never trust
 * client body organisation_id / service_area_id / currency as authority.
 */
export type CorporateMembership = {
  userId: string;
  corporateAccountId: string;
  role: string;
};

export type CorporateAccountRow = {
  id: string;
  status: string | null;
  service_area_id: string | null;
};

export type ServiceAreaRow = {
  id: string;
  currency: string | null;
  financial_model: string | null;
};

export function resolveAuthoritativeCorporateAccountId(args: {
  memberships: CorporateMembership[];
  requestedCorporateAccountId: string | null | undefined;
  userId: string;
}): { ok: true; corporateAccountId: string; role: string } | {
  ok: false;
  code: "CORPORATE_ACCESS_DENIED" | "CORPORATE_ORG_MISMATCH";
} {
  const mine = args.memberships.filter((m) => m.userId === args.userId);
  if (mine.length === 0) return { ok: false, code: "CORPORATE_ACCESS_DENIED" };

  const requested = String(args.requestedCorporateAccountId ?? "").trim();
  if (!requested) {
    // Single membership may be implied; multi-org must specify — still fail closed if ambiguous
    if (mine.length === 1) {
      return { ok: true, corporateAccountId: mine[0].corporateAccountId, role: mine[0].role };
    }
    return { ok: false, code: "CORPORATE_ACCESS_DENIED" };
  }

  const hit = mine.find((m) => m.corporateAccountId === requested);
  if (!hit) return { ok: false, code: "CORPORATE_ORG_MISMATCH" };
  return { ok: true, corporateAccountId: hit.corporateAccountId, role: hit.role };
}

export function assertCorporateAccountBookable(
  account: CorporateAccountRow | null,
): { ok: true } | { ok: false; code: "CORPORATE_NOT_FOUND" | "CORPORATE_SUSPENDED" | "CORPORATE_UNAPPROVED" } {
  if (!account) return { ok: false, code: "CORPORATE_NOT_FOUND" };
  const status = String(account.status ?? "").toLowerCase();
  if (status === "suspended" || status === "disabled" || status === "rejected") {
    return { ok: false, code: "CORPORATE_SUSPENDED" };
  }
  if (status && status !== "active" && status !== "approved") {
    // pending / unapproved
    if (status === "pending" || status === "submitted" || status === "unapproved") {
      return { ok: false, code: "CORPORATE_UNAPPROVED" };
    }
  }
  return { ok: true };
}

export function assertServiceAreaInOrgScope(args: {
  account: CorporateAccountRow;
  requestedServiceAreaId: string;
  serviceArea: ServiceAreaRow | null;
  clientCurrency?: string | null;
}): { ok: true; currency: string; financialModel: string } | {
  ok: false;
  code:
    | "SERVICE_AREA_REQUIRED"
    | "SERVICE_AREA_OUT_OF_SCOPE"
    | "SERVICE_AREA_NOT_FOUND"
    | "CURRENCY_MISMATCH"
    | "FINANCIAL_MODEL_VIOLATION";
} {
  const assigned = String(args.account.service_area_id ?? "").trim();
  const requested = String(args.requestedServiceAreaId ?? "").trim();
  if (!assigned) return { ok: false, code: "SERVICE_AREA_REQUIRED" };
  if (!requested || requested !== assigned) {
    return { ok: false, code: "SERVICE_AREA_OUT_OF_SCOPE" };
  }
  if (!args.serviceArea || args.serviceArea.id !== assigned) {
    return { ok: false, code: "SERVICE_AREA_NOT_FOUND" };
  }
  const currency = String(args.serviceArea.currency ?? "GBP").toUpperCase();
  if (args.clientCurrency) {
    const cc = String(args.clientCurrency).toUpperCase();
    if (cc && cc !== currency) return { ok: false, code: "CURRENCY_MISMATCH" };
  }
  const financialModel = String(args.serviceArea.financial_model ?? "");
  if (financialModel && financialModel !== "PLATFORM_COLLECTED") {
    return { ok: false, code: "FINANCIAL_MODEL_VIOLATION" };
  }
  return { ok: true, currency, financialModel };
}

export function assertClientActionIdOrgBound(args: {
  sessionCorporateAccountId: string | null | undefined;
  authoritativeCorporateAccountId: string;
}): { ok: true } | { ok: false; code: "CLIENT_ACTION_ORG_REUSE_DENIED" } {
  const sid = String(args.sessionCorporateAccountId ?? "").trim();
  if (!sid) return { ok: true }; // new key
  if (sid !== args.authoritativeCorporateAccountId) {
    return { ok: false, code: "CLIENT_ACTION_ORG_REUSE_DENIED" };
  }
  return { ok: true };
}

export function assertPaymentMethodAllowed(args: {
  method: string;
  /** Production prep: only card unless server marks another method implemented+enabled. */
  cardEnabled: boolean;
  walletImplementedAndEnabled: boolean;
  invoiceImplementedAndEnabled: boolean;
}): { ok: true } | { ok: false; code: "PAYMENT_METHOD_UNAVAILABLE" } {
  const m = args.method.toLowerCase();
  if (m === "card") {
    return args.cardEnabled ? { ok: true } : { ok: false, code: "PAYMENT_METHOD_UNAVAILABLE" };
  }
  if (m === "wallet") {
    return args.walletImplementedAndEnabled
      ? { ok: true }
      : { ok: false, code: "PAYMENT_METHOD_UNAVAILABLE" };
  }
  if (m === "invoice" || m === "corporate_account") {
    return args.invoiceImplementedAndEnabled
      ? { ok: true }
      : { ok: false, code: "PAYMENT_METHOD_UNAVAILABLE" };
  }
  return { ok: false, code: "PAYMENT_METHOD_UNAVAILABLE" };
}
