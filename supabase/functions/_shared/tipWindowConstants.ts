/** Post-trip tip window duration (customer optional tip UI). Backend authority. */
export const TIP_WINDOW_MS = 20 * 60 * 1000;

export const TIP_WINDOW_STATUS = {
  OPEN: "open",
  CLOSED: "closed",
} as const;

export type TipWindowStatus =
  (typeof TIP_WINDOW_STATUS)[keyof typeof TIP_WINDOW_STATUS];
