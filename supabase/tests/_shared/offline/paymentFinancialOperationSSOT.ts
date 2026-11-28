/** Offline test/audit-only helpers; not part of Edge uploads. */


/** Legacy workers without fence/execution_id must not mutate financial confirmations. */
export function assertModernFinancialWriter(args: {
  executionId?: string | null;
  fence?: string | null;
  schemaAware: boolean;
}): { ok: true } | { ok: false; code: "LEGACY_WRITER_BLOCKED" } {
  if (!args.schemaAware) {
    return { ok: false, code: "LEGACY_WRITER_BLOCKED" };
  }
  if (!String(args.executionId ?? "").trim() || !String(args.fence ?? "").trim()) {
    return { ok: false, code: "LEGACY_WRITER_BLOCKED" };
  }
  return { ok: true };
}

export * from "../../../functions/_shared/paymentFinancialOperationSSOT.ts";
