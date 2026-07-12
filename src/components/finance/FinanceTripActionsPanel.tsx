import { Link } from 'react-router-dom';
import {
  Banknote, ExternalLink, Eye, FileText, RefreshCw, Undo2, XCircle, ArrowDownToLine,
  Wrench, Calculator, Wallet, User, Car, CreditCard, PlusCircle, MinusCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  derivePaymentActionAvailability,
  type PaymentActionKey,
  type TripPaymentActionInput,
} from '@/lib/financeTripActionsSSOT';
import { financialReconciliationTripsTabUrl } from '@/lib/financialReconciliationRoutes';
import { driverWalletLedgerUrl } from '@/lib/driverWalletLedgerRoutes';
import { tripSettlementRecoverUrl } from '@/lib/financialReconciliationRoutes';

export type FinanceTripActionsContext = {
  tripId: string;
  tripCode?: string | null;
  paymentIntentId?: string | null;
  chargeId?: string | null;
  driverId?: string | null;
  passengerId?: string | null;
};

type FinanceTripActionsPanelProps = {
  context: FinanceTripActionsContext;
  paymentInput: TripPaymentActionInput;
  actionsDisabled?: boolean;
  onCapture?: () => void;
  onRefundFull?: () => void;
  onRefundPartial?: () => void;
  onCancelAuthorisation?: () => void;
  onResyncStripe?: () => void;
  onRequestExtraPayment?: () => void;
  onRepairSettlement?: () => void;
  onRecalculateSettlement?: () => void;
  onViewAuditLog?: () => void;
  onDriverCredit?: () => void;
  onDriverDebit?: () => void;
  onCustomerCredit?: () => void;
  onCustomerDebit?: () => void;
  onPlatformAdjustment?: () => void;
  onCommissionAdjustment?: () => void;
  isPending?: boolean;
};

function ActionButton({
  label,
  enabled,
  reason,
  disabled: forceDisabled,
  onClick,
  variant = 'outline',
  icon,
  isPending,
}: {
  label: string;
  enabled: boolean;
  reason?: string;
  disabled?: boolean;
  onClick?: () => void;
  variant?: 'default' | 'outline' | 'destructive' | 'secondary' | 'ghost';
  icon?: React.ReactNode;
  isPending?: boolean;
}) {
  const btn = (
    <Button
      size="sm"
      variant={variant}
      className="h-8 text-xs justify-start"
      disabled={forceDisabled || !enabled || !onClick || isPending}
      onClick={onClick}
    >
      {icon}
      {label}
    </Button>
  );

  if (!enabled && reason) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-block">{btn}</span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-xs">{reason}</TooltipContent>
      </Tooltip>
    );
  }
  return btn;
}

function ViewLink({ to, label, icon }: { to: string; label: string; icon: React.ReactNode }) {
  return (
    <Button asChild size="sm" variant="ghost" className="h-8 text-xs justify-start">
      <Link to={to}>
        {icon}
        {label}
        <ExternalLink className="h-3 w-3 ml-1 opacity-50" />
      </Link>
    </Button>
  );
}

export function FinanceTripActionsPanel({
  context,
  paymentInput,
  actionsDisabled = false,
  onCapture,
  onRefundFull,
  onRefundPartial,
  onCancelAuthorisation,
  onResyncStripe,
  onRequestExtraPayment,
  onRepairSettlement,
  onRecalculateSettlement,
  onViewAuditLog,
  onDriverCredit,
  onDriverDebit,
  onCustomerCredit,
  onCustomerDebit,
  onPlatformAdjustment,
  onCommissionAdjustment,
  isPending = false,
}: FinanceTripActionsPanelProps) {
  const availability = derivePaymentActionAvailability(paymentInput);
  const stripePiUrl = context.paymentIntentId
    ? `https://dashboard.stripe.com/payments/${context.paymentIntentId}`
    : null;

  const paymentButtons: Array<{
    key: PaymentActionKey;
    label: string;
    icon: React.ReactNode;
    onClick?: () => void;
    variant?: 'default' | 'outline' | 'destructive';
  }> = [
    { key: 'capture', label: 'Capture Payment', icon: <Banknote className="h-3.5 w-3.5 mr-1 shrink-0" />, onClick: onCapture, variant: 'default' },
    { key: 'retry_capture', label: 'Retry Capture', icon: <RefreshCw className="h-3.5 w-3.5 mr-1 shrink-0" />, onClick: onCapture },
    { key: 'refund_full', label: 'Refund Full', icon: <Undo2 className="h-3.5 w-3.5 mr-1 shrink-0" />, onClick: onRefundFull, variant: 'destructive' },
    { key: 'refund_partial', label: 'Refund Partial', icon: <ArrowDownToLine className="h-3.5 w-3.5 mr-1 shrink-0" />, onClick: onRefundPartial, variant: 'destructive' },
    { key: 'cancel_authorisation', label: 'Cancel Authorisation', icon: <XCircle className="h-3.5 w-3.5 mr-1 shrink-0" />, onClick: onCancelAuthorisation, variant: 'destructive' },
    { key: 'void_payment', label: 'Void Payment (before capture)', icon: <XCircle className="h-3.5 w-3.5 mr-1 shrink-0" />, onClick: onCancelAuthorisation, variant: 'destructive' },
    { key: 'request_extra_payment', label: 'Request Extra Payment', icon: <PlusCircle className="h-3.5 w-3.5 mr-1 shrink-0" />, onClick: onRequestExtraPayment },
    // Stripe sync/refresh retired from active finance — omit live controls
    { key: 'repair_settlement', label: 'Repair Settlement', icon: <Wrench className="h-3.5 w-3.5 mr-1 shrink-0" />, onClick: onRepairSettlement },
    { key: 'recalculate_settlement', label: 'Recalculate Settlement', icon: <Calculator className="h-3.5 w-3.5 mr-1 shrink-0" />, onClick: onRecalculateSettlement },
    { key: 'retry_settlement', label: 'Retry Settlement', icon: <RefreshCw className="h-3.5 w-3.5 mr-1 shrink-0" />, onClick: onRepairSettlement },
  ];

  return (
    <TooltipProvider delayDuration={300}>
      <div className="space-y-4 rounded-md border bg-muted/20 p-3">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Trip Actions</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
            <ViewLink
              to={tripSettlementRecoverUrl(context.tripId, context.tripCode)}
              label="View Trip"
              icon={<Eye className="h-3.5 w-3.5 mr-1 shrink-0" />}
            />
            {stripePiUrl ? (
              <Button asChild size="sm" variant="ghost" className="h-8 text-xs justify-start">
                <a href={stripePiUrl} target="_blank" rel="noopener noreferrer">
                  <CreditCard className="h-3.5 w-3.5 mr-1 shrink-0" />
                  View PaymentIntent
                  <ExternalLink className="h-3 w-3 ml-1 opacity-50" />
                </a>
              </Button>
            ) : (
              <ActionButton label="View PaymentIntent" enabled={false} reason="No PaymentIntent on trip" disabled />
            )}
            {context.chargeId ? (
              <Button asChild size="sm" variant="ghost" className="h-8 text-xs justify-start">
                <a href={`https://dashboard.stripe.com/payments/${context.chargeId}`} target="_blank" rel="noopener noreferrer">
                  <CreditCard className="h-3.5 w-3.5 mr-1 shrink-0" />
                  View Charge
                  <ExternalLink className="h-3 w-3 ml-1 opacity-50" />
                </a>
              </Button>
            ) : (
              <ActionButton label="View Charge" enabled={false} reason="No charge recorded yet" disabled />
            )}
            {context.passengerId ? (
              <ViewLink to={`/riders?search=${context.passengerId}`} label="View Customer" icon={<User className="h-3.5 w-3.5 mr-1 shrink-0" />} />
            ) : (
              <ActionButton label="View Customer" enabled={false} reason="No customer linked" disabled />
            )}
            {context.driverId ? (
              <ViewLink
                to={driverWalletLedgerUrl(context.driverId, 'overview')}
                label="View Driver"
                icon={<Car className="h-3.5 w-3.5 mr-1 shrink-0" />}
              />
            ) : (
              <ActionButton label="View Driver" enabled={false} reason="No driver assigned" disabled />
            )}
            <ViewLink
              to={financialReconciliationTripsTabUrl(context.tripId, context.tripCode)}
              label="View Settlement"
              icon={<Calculator className="h-3.5 w-3.5 mr-1 shrink-0" />}
            />
            {context.driverId ? (
              <ViewLink
                to={(() => {
                  const params = new URLSearchParams({ driverId: context.driverId!, tab: 'ledger', tripId: context.tripId });
                  return `/driver-wallet-ledger?${params.toString()}`;
                })()}
                label="View Wallet Ledger"
                icon={<Wallet className="h-3.5 w-3.5 mr-1 shrink-0" />}
              />
            ) : (
              <ActionButton label="View Wallet Ledger" enabled={false} reason="No driver assigned" disabled />
            )}
            <ViewLink
              to={`/financial-reconciliation?tab=stripe${context.paymentIntentId ? `&pi=${context.paymentIntentId}` : ''}`}
              label="View Provider Events"
              icon={<CreditCard className="h-3.5 w-3.5 mr-1 shrink-0" />}
            />
            <ActionButton
              label="View Audit Log"
              enabled
              onClick={onViewAuditLog}
              icon={<FileText className="h-3.5 w-3.5 mr-1 shrink-0" />}
              disabled={actionsDisabled}
              isPending={isPending}
            />
          </div>
        </div>

        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Payment Actions</h4>
          <p className="text-[11px] text-muted-foreground mb-2">
            Enabled or disabled by Provider/payment state only — not by reconciliation match.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
            {paymentButtons.map(({ key, label, icon, onClick, variant }) => {
              const rule = availability[key];
              return (
                <ActionButton
                  key={key}
                  label={label}
                  enabled={rule.enabled}
                  reason={rule.reason}
                  onClick={onClick}
                  variant={variant ?? 'outline'}
                  icon={icon}
                  disabled={actionsDisabled}
                  isPending={isPending}
                />
              );
            })}
          </div>
        </div>

        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Adjustment Actions</h4>
          <p className="text-[11px] text-muted-foreground mb-2">
            Available when permitted — not hidden when reconciliation is healthy.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
            <ActionButton
              label="Driver Credit"
              enabled={!!context.driverId}
              reason="No driver assigned"
              onClick={onDriverCredit}
              icon={<PlusCircle className="h-3.5 w-3.5 mr-1 shrink-0" />}
              disabled={actionsDisabled}
              isPending={isPending}
            />
            <ActionButton
              label="Driver Debit"
              enabled={!!context.driverId}
              reason="No driver assigned"
              onClick={onDriverDebit}
              icon={<MinusCircle className="h-3.5 w-3.5 mr-1 shrink-0" />}
              disabled={actionsDisabled}
              isPending={isPending}
            />
            <ActionButton
              label="Customer Credit"
              enabled={!!context.passengerId}
              reason="No customer linked"
              onClick={onCustomerCredit}
              icon={<PlusCircle className="h-3.5 w-3.5 mr-1 shrink-0" />}
              disabled={actionsDisabled}
              isPending={isPending}
            />
            <ActionButton
              label="Customer Debit"
              enabled={!!context.passengerId}
              reason="No customer linked"
              onClick={onCustomerDebit}
              icon={<MinusCircle className="h-3.5 w-3.5 mr-1 shrink-0" />}
              disabled={actionsDisabled}
              isPending={isPending}
            />
            <ActionButton
              label="Platform Adjustment"
              enabled
              onClick={onPlatformAdjustment}
              icon={<Wrench className="h-3.5 w-3.5 mr-1 shrink-0" />}
              disabled={actionsDisabled}
              isPending={isPending}
            />
            <ActionButton
              label="Commission Adjustment"
              enabled={!!context.driverId}
              reason="No driver assigned"
              onClick={onCommissionAdjustment}
              icon={<Calculator className="h-3.5 w-3.5 mr-1 shrink-0" />}
              disabled={actionsDisabled}
              isPending={isPending}
            />
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
