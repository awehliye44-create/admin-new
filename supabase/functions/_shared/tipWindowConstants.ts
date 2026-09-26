/** Post-trip tip window duration (customer optional tip UI). Backend authority. */
export const TIP_WINDOW_MS = 20 * 60 * 1000;

export const TIP_WINDOW_STATUS = {
  OPEN: "open",
  PROCESSING: "processing",
  CLOSED: "closed",
  EXPIRED: "expired",
} as const;

export type TipWindowStatus =
  (typeof TIP_WINDOW_STATUS)[keyof typeof TIP_WINDOW_STATUS];

/** Exactly one of these may own tip-window finalisation. */
export const TIP_WINDOW_TRIGGER = {
  CUSTOMER_SKIP: "CUSTOMER_SKIP",
  CUSTOMER_SUBMIT_NO_TIP: "CUSTOMER_SUBMIT_NO_TIP",
  CUSTOMER_SUBMIT_WITH_TIP: "CUSTOMER_SUBMIT_WITH_TIP",
  WINDOW_EXPIRED: "WINDOW_EXPIRED",
} as const;

export type TipWindowTrigger =
  (typeof TIP_WINDOW_TRIGGER)[keyof typeof TIP_WINDOW_TRIGGER];

/** Tip increment/auth declined — fare must remain AUTHORISED; window stays OPEN. */
export const TIP_AUTHORISATION_DECLINED = "TIP_AUTHORISATION_DECLINED";

export const TIP_AUTHORISATION_DECLINED_CUSTOMER_MESSAGE =
  "Your bank declined the tip. Your fare has not been taken yet. You can try again, continue without a tip, or skip.";

/**
 * Tip > 0 was requested but confirmed capture did not cover the tip
 * (fare-only already_captured / tip_shortfall). Must NOT seal tip=0 under
 * CUSTOMER_SUBMIT_WITH_TIP — release claim, keep window OPEN, let Skip / tip=0 close.
 */
export const TIP_NOT_COLLECTED = "TIP_NOT_COLLECTED";

export const TIP_NOT_COLLECTED_CUSTOMER_MESSAGE =
  "The fare was already taken, so this tip could not be added. You can continue without a tip or skip.";

export function resolveCustomerTipWindowTrigger(args: {
  tipAmountPence: number;
  skip?: boolean;
}): TipWindowTrigger {
  const tip = Math.max(0, Math.round(Number(args.tipAmountPence) || 0));
  if (tip > 0) return TIP_WINDOW_TRIGGER.CUSTOMER_SUBMIT_WITH_TIP;
  if (args.skip === true) return TIP_WINDOW_TRIGGER.CUSTOMER_SKIP;
  return TIP_WINDOW_TRIGGER.CUSTOMER_SUBMIT_NO_TIP;
}

export function tipWindowTerminalStatusForTrigger(
  trigger: TipWindowTrigger,
): typeof TIP_WINDOW_STATUS.CLOSED | typeof TIP_WINDOW_STATUS.EXPIRED {
  return trigger === TIP_WINDOW_TRIGGER.WINDOW_EXPIRED
    ? TIP_WINDOW_STATUS.EXPIRED
    : TIP_WINDOW_STATUS.CLOSED;
}
