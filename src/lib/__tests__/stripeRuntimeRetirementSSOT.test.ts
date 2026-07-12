import { describe, expect, it } from "vitest";
import {
  isPayoutDestinationReady,
  mondaySettlementAllowedWithoutStripeExecution,
  resolveActivePayoutProviderFromServiceArea,
} from "../../../shared/stripeRuntimeRetirementSSOT";
import { isStripeRuntimeDisabled } from "../../../src/lib/stripeRuntimeDisabled";

describe("Slice 8 Stripe runtime retirement", () => {
  it("prefers driver_payout_gateway over legacy payment_provider=stripe", () => {
    expect(resolveActivePayoutProviderFromServiceArea({
      payment_provider: "stripe",
      driver_payout_gateway: "revolut",
    })).toBe("revolut");
  });

  it("never returns stripe as an active payout provider", () => {
    expect(resolveActivePayoutProviderFromServiceArea({
      payment_provider: "stripe",
      driver_payout_gateway: "stripe",
    })).toBeNull();
  });

  it("allows Monday settlement for Revolut without Stripe execution flag", () => {
    expect(mondaySettlementAllowedWithoutStripeExecution({
      payout_provider: "revolut",
      stripe_execution_enabled: false,
    })).toBe(true);
    expect(mondaySettlementAllowedWithoutStripeExecution({
      payout_provider: "stripe",
      stripe_execution_enabled: false,
    })).toBe(false);
  });

  it("Revolut destination ready without Connect account id", () => {
    expect(isPayoutDestinationReady({
      manual_provider_payout: true,
      payouts_enabled: true,
      legacy_connect_account_id: null,
    })).toBe(true);
    expect(isPayoutDestinationReady({
      manual_provider_payout: false,
      legacy_connect_account_id: null,
    })).toBe(false);
  });

  it("client kill switch defaults to disabled Stripe", () => {
    expect(isStripeRuntimeDisabled()).toBe(true);
  });
});
