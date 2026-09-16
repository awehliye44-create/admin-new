/**
 * Admin Trip History — financial breakdown display from stored SSOT stamps.
 * Never invents fares, rates, or £0 for missing legacy columns.
 */
import { Label } from '@/components/ui/label';
import {
  formatSignedStoredPenceOrUnknown,
  formatStoredPenceOrUnavailable,
  formatStoredPenceOrUnknown,
  isPositiveStoredPence,
  nullableStoredPence,
  resolveTripAirportPence,
  resolveTripTipPence,
  storedPenceDifference,
  sumKnownEntitlementComponentsPence,
} from '@/lib/adminFareComponentDisplay';
import { buildCanonicalTripEconomicsRead } from '../../../shared/paymentSessionsCanonicalReadAdapterSSOT';

export type TripHistoryFinancialBreakdownTrip = {
  tip_pence?: number | null;
  tip_amount_pence?: number | null;
  airport_charge_pence?: number | null;
  final_customer_fare_pence?: number | null;
  final_fare_pence?: number | null;
  locked_base_fare_pence?: number | null;
  accepted_preset_offer_fare_pence?: number | null;
  accepted_driver_offer_fare_pence?: number | null;
  pickup_waiting_charge_pence?: number | null;
  stop_waiting_charge_pence?: number | null;
  stop_charge_total_pence?: number | null;
  total_waiting_charge_pence?: number | null;
  waiting_charge_pence?: number | null;
  customer_modification_charge_pence?: number | null;
  destination_change_adjustment_pence?: number | null;
  commissionable_fare_pence?: number | null;
  commission_pence?: number | null;
  accepted_commission_percent?: number | null;
  driver_tier_commission_percent?: number | null;
  driver_net_pence?: number | null;
  discount_pence?: number | null;
  financial_model?: string | null;
};

export type TripHistoryFinancialBreakdownEvidence = {
  totalPaidPence: number | null;
  refundedPence: number | null;
  netPaidPence: number | null;
  /** Optional wallet actual when known from ledger evidence. */
  actualWalletCreditPence?: number | null;
};

function Field({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'muted' | 'danger' | 'default';
}) {
  const className =
    tone === 'danger'
      ? 'font-medium text-red-600'
      : tone === 'muted'
        ? 'font-medium text-muted-foreground'
        : 'font-medium';
  return (
    <div>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <p className={className}>{value}</p>
    </div>
  );
}

function formatCommissionRate(trip: TripHistoryFinancialBreakdownTrip): string {
  const accepted = trip.accepted_commission_percent;
  if (accepted != null && Number.isFinite(Number(accepted))) {
    return `${Number(accepted)}%`;
  }
  const tier = trip.driver_tier_commission_percent;
  if (tier != null && Number.isFinite(Number(tier))) {
    return `${Number(tier)}%`;
  }
  return 'Unknown';
}

function showPositiveRow(pence: number | null | undefined): boolean {
  return isPositiveStoredPence(pence);
}

/**
 * Structured Customer / ONECAB / Driver breakdown for Trip History detail.
 * PLATFORM_COLLECTED presentation; DRIVER_COLLECTED shows a note and skips platform capture rows.
 */
export function TripHistoryFinancialBreakdown({
  trip,
  evidence,
  currencyCode = 'GBP',
}: {
  trip: TripHistoryFinancialBreakdownTrip;
  evidence: TripHistoryFinancialBreakdownEvidence;
  currencyCode?: string;
}) {
  const eco = buildCanonicalTripEconomicsRead(trip);
  const tipPence = resolveTripTipPence(trip);
  const airportPence = resolveTripAirportPence(trip);
  const farePence = nullableStoredPence(eco.final_customer_payable_pence)
    ?? nullableStoredPence(eco.final_fare_pence);
  const model = String(trip.financial_model ?? '').toUpperCase();
  const isDriverCollected = model.includes('DRIVER_COLLECTED');

  const expectedTotal = sumKnownEntitlementComponentsPence({
    fareNetPence: eco.driver_net_pence,
    airportPence,
    tipPence,
  });
  const actualWallet = nullableStoredPence(evidence.actualWalletCreditPence);
  const difference = storedPenceDifference(actualWallet, expectedTotal);

  return (
    <div className="space-y-4 col-span-2" data-testid="trip-history-financial-breakdown">
      {isDriverCollected ? (
        <p className="text-xs text-muted-foreground">
          DRIVER_COLLECTED — platform capture / wallet entitlement rows are not applicable.
          Tip and airport stamps below are stored trip fields only.
        </p>
      ) : null}

      <div className="space-y-2">
        <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Customer payment
        </h5>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <Field label="Fare" value={formatStoredPenceOrUnknown(farePence, currencyCode)} />
          {airportPence != null ? (
            showPositiveRow(airportPence) ? (
              <Field
                label="Airport charge"
                value={formatStoredPenceOrUnknown(airportPence, currencyCode)}
              />
            ) : null
          ) : (
            <Field label="Airport charge" value="Unknown" />
          )}
          {showPositiveRow(eco.pickup_waiting_pence) ? (
            <Field
              label="Pickup waiting"
              value={formatStoredPenceOrUnknown(eco.pickup_waiting_pence, currencyCode)}
            />
          ) : null}
          {showPositiveRow(eco.stop_waiting_pence) ? (
            <Field
              label="Stop waiting"
              value={formatStoredPenceOrUnknown(eco.stop_waiting_pence, currencyCode)}
            />
          ) : null}
          {showPositiveRow(eco.accepted_preset_offer_fare_pence) ? (
            <Field
              label="Preset quote (audit)"
              value={formatStoredPenceOrUnknown(eco.accepted_preset_offer_fare_pence, currencyCode)}
              tone="muted"
            />
          ) : null}
          {showPositiveRow(eco.modification_audit_pence) ? (
            <Field
              label="Modification (audit)"
              value={formatStoredPenceOrUnknown(eco.modification_audit_pence, currencyCode)}
              tone="muted"
            />
          ) : null}
          {tipPence != null ? (
            showPositiveRow(tipPence) ? (
              <Field label="Tip" value={formatStoredPenceOrUnknown(tipPence, currencyCode)} />
            ) : null
          ) : (
            <Field label="Tip" value="Unknown" />
          )}
          <Field
            label="Total paid"
            value={formatStoredPenceOrUnknown(evidence.totalPaidPence, currencyCode)}
          />
          {showPositiveRow(evidence.refundedPence) ? (
            <Field
              label="Refunded"
              value={formatStoredPenceOrUnknown(evidence.refundedPence, currencyCode)}
              tone="danger"
            />
          ) : evidence.refundedPence === 0 ? (
            <Field
              label="Refunded"
              value={formatStoredPenceOrUnknown(0, currencyCode)}
            />
          ) : (
            <Field
              label="Refunded"
              value={formatStoredPenceOrUnavailable(
                null,
                currencyCode,
                'Payment Session refund evidence not loaded',
              )}
            />
          )}
          <Field
            label="Net paid"
            value={formatStoredPenceOrUnknown(evidence.netPaidPence, currencyCode)}
          />
        </div>
      </div>

      {!isDriverCollected ? (
        <div className="space-y-2">
          <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            ONECAB
          </h5>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Field
              label="Commissionable fare"
              value={formatStoredPenceOrUnknown(eco.commissionable_fare_pence, currencyCode)}
            />
            <Field label="Commission rate" value={formatCommissionRate(trip)} />
            <Field
              label="Commission amount"
              value={formatStoredPenceOrUnknown(eco.commission_pence, currencyCode)}
            />
            {airportPence != null ? (
              showPositiveRow(airportPence) ? (
                <Field
                  label="Non-commissionable airport"
                  value={formatStoredPenceOrUnknown(airportPence, currencyCode)}
                />
              ) : null
            ) : (
              <Field label="Non-commissionable airport" value="Unknown" />
            )}
            {tipPence != null ? (
              showPositiveRow(tipPence) ? (
                <Field
                  label="Non-commissionable tip"
                  value={formatStoredPenceOrUnknown(tipPence, currencyCode)}
                />
              ) : null
            ) : (
              <Field label="Non-commissionable tip" value="Unknown" />
            )}
          </div>
        </div>
      ) : null}

      {!isDriverCollected ? (
        <div className="space-y-2">
          <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Driver
          </h5>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Field
              label="Fare net"
              value={formatStoredPenceOrUnknown(eco.driver_net_pence, currencyCode)}
            />
            {airportPence != null ? (
              showPositiveRow(airportPence) ? (
                <Field
                  label="Airport entitlement"
                  value={formatStoredPenceOrUnknown(airportPence, currencyCode)}
                />
              ) : null
            ) : (
              <Field label="Airport entitlement" value="Unknown" />
            )}
            {tipPence != null ? (
              showPositiveRow(tipPence) ? (
                <Field
                  label="Tip entitlement"
                  value={formatStoredPenceOrUnknown(tipPence, currencyCode)}
                />
              ) : null
            ) : (
              <Field label="Tip entitlement" value="Unknown" />
            )}
            <Field
              label="Total expected entitlement"
              value={formatStoredPenceOrUnknown(expectedTotal, currencyCode)}
            />
            <Field
              label="Actual wallet credit"
              value={formatStoredPenceOrUnavailable(
                actualWallet,
                currencyCode,
                actualWallet == null
                  ? 'Wallet ledger credit not loaded on this panel'
                  : null,
              )}
            />
            <Field
              label="Difference"
              value={
                difference == null
                  ? formatStoredPenceOrUnavailable(
                    null,
                    currencyCode,
                    'Requires expected and actual wallet credit',
                  )
                  : formatSignedStoredPenceOrUnknown(difference, currencyCode)
              }
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
