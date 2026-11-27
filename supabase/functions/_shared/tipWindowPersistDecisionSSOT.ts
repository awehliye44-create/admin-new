/**
 * #110 P2 — Tip-window persist decision SSOT.
 *
 * When completion already durably stamped the open tip window, settlement must
 * still persist — but tip_window_* columns must not be rewritten (no reopen,
 * no deadline extension). Recovery re-stamps only when the expected open window
 * is missing or inconsistent.
 */

import { TIP_WINDOW_STATUS } from "./tipWindowConstants.ts";

export type TipWindowPersistedRow = {
  tip_window_opened_at?: string | null;
  tip_window_expires_at?: string | null;
  tip_window_status?: string | null;
  tip_window_closed_at?: string | null;
};

export type ExpectedOpenTipWindow = {
  tip_window_opened_at: string;
  tip_window_expires_at: string;
  tip_window_status: string;
  tip_window_closed_at: null;
};

/**
 * Normalise tip-window timestamps for authoritative compare.
 * Postgres RETURNING often yields `+00:00` while Edge stamps `Z` — string
 * inequality must not force a redundant recovery re-SELECT (B4-A).
 */
export function normalizeTipWindowTimestamp(
  value: string | null | undefined,
): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return raw;
  return new Date(ms).toISOString();
}

/** True when all tip_window_* fields required for verify are present on the row. */
export function tipWindowReturningHasAllFields(
  row: TipWindowPersistedRow | null | undefined,
): boolean {
  if (!row) return false;
  return (
    row.tip_window_opened_at != null &&
    String(row.tip_window_opened_at).trim() !== "" &&
    row.tip_window_expires_at != null &&
    String(row.tip_window_expires_at).trim() !== "" &&
    row.tip_window_status != null &&
    String(row.tip_window_status).trim() !== ""
  );
}

/** True when DB already holds the exact open window completion intended. */
export function isAuthoritativeTipWindowPersisted(args: {
  expected: ExpectedOpenTipWindow | null | undefined;
  persisted: TipWindowPersistedRow | null | undefined;
}): boolean {
  const expected = args.expected;
  const row = args.persisted;
  if (!expected || !row) return false;
  if (row.tip_window_closed_at != null) return false;
  if (String(row.tip_window_status ?? "").toLowerCase() !== TIP_WINDOW_STATUS.OPEN) {
    return false;
  }
  if (
    normalizeTipWindowTimestamp(row.tip_window_opened_at) !==
      normalizeTipWindowTimestamp(expected.tip_window_opened_at)
  ) {
    return false;
  }
  if (
    normalizeTipWindowTimestamp(row.tip_window_expires_at) !==
      normalizeTipWindowTimestamp(expected.tip_window_expires_at)
  ) {
    return false;
  }
  return true;
}

/**
 * Settlement + tip columns for the post-completion trips UPDATE.
 * When skipTipWindowColumns, omit tip_window_* so original stamps stay intact.
 */
export function buildTipWindowSettlementUpdate(args: {
  settlementColumns: Record<string, number | string | null>;
  tipAmountPence: number;
  finalFarePence: number;
  finalCustomerFarePence: number;
  completedAtIso: string;
  expiresAtIso: string;
  skipTipWindowColumns: boolean;
  updatedAtIso: string;
}): Record<string, number | string | null> {
  const base: Record<string, number | string | null> = {
    ...args.settlementColumns,
    tip_amount_pence: args.tipAmountPence,
    tip_pence: args.tipAmountPence,
    final_fare_pence: args.finalFarePence,
    final_customer_fare_pence: args.finalCustomerFarePence,
    updated_at: args.updatedAtIso,
  };
  if (args.skipTipWindowColumns) {
    return base;
  }
  return {
    ...base,
    tip_window_opened_at: args.completedAtIso,
    tip_window_expires_at: args.expiresAtIso,
    tip_window_status: TIP_WINDOW_STATUS.OPEN,
    tip_window_closed_at: null,
  };
}
