import { describe, expect, it } from "vitest";
import {
  computeProtectedDriverLiabilitiesPence,
  computeProtectedDriverLiabilityForDriver,
  PROTECTED_LIABILITY_ACCEPTANCE_PROOF,
} from "../../../shared/protectedDriverLiabilitiesSSOT";
import { computeCompanyAvailableBeforeOperationalReservePence } from "../../../shared/companyBalanceSSOT";

describe("protectedDriverLiabilitiesSSOT", () => {
  it("MK acceptance: pending £23.20 blocks £20.65 before-reserve illusion", () => {
    const breakdown = computeProtectedDriverLiabilitiesPence([
      { driver_id: "mk1", pending_clearing_pence: 1576 },
      { driver_id: "mk2", pending_clearing_pence: 744 },
    ]);
    expect(breakdown.total_pence).toBe(2320);

    const before = computeCompanyAvailableBeforeOperationalReservePence({
      provider_available_balance_pence: PROTECTED_LIABILITY_ACCEPTANCE_PROOF.REVOLUT_SOURCE_PENCE,
      driver_liability_pence: breakdown.total_pence,
      approved_company_payables_pence: PROTECTED_LIABILITY_ACCEPTANCE_PROOF.APPROVED_PAYABLES_PENCE,
      customer_refund_reserved_pence: null,
    });
    expect(before).toBe(0);
  });

  it("does not double-count live wallet and pending clearing", () => {
    expect(computeProtectedDriverLiabilityForDriver({
      driver_id: "d1",
      live_wallet_pence: 1000,
      available_pence: 800,
      pending_clearing_pence: 200,
    })).toBe(1000);
  });
});
