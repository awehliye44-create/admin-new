/** Offline test/audit-only helpers; not part of Edge uploads. */
import { computeAvailableCashOutPence } from "../../../functions/_shared/driverWalletPayoutSSOT.ts";


/** @deprecated Use computeAvailableCashOutPence — wallet must not cap cash-out. */
export function computeCashoutLimitPence(input: {
  wallet_owed_pence: number;
  finance_cleared_pence: number;
  provider_instant_available_pence: number | null | undefined;
  recovery_debt_pence: number;
  in_flight_cashout_pence?: number;
  payout_blocked?: boolean;
  instant_enabled?: boolean;
  provider_available_pence?: number | null;
}): number {
  return computeAvailableCashOutPence({
    provider_available_pence: input.provider_available_pence ?? null,
    provider_instant_available_pence: input.provider_instant_available_pence,
    finance_cleared_pence: input.finance_cleared_pence,
    recovery_debt_pence: input.recovery_debt_pence,
    in_flight_cashout_pence: input.in_flight_cashout_pence,
    payout_blocked: input.payout_blocked,
    instant_enabled: input.instant_enabled,
  });
}

export * from "../../../functions/_shared/driverWalletPayoutSSOT.ts";
