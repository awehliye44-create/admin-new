/** @deprecated Stripe Connect money movement removed — type retained for finance summary shape only. */
export type ConnectMoneyMovementBundle = {
  available_pence: number;
  pending_pence: number;
  note?: string;
};

export function emptyConnectMoneyMovement(): ConnectMoneyMovementBundle {
  return { available_pence: 0, pending_pence: 0, note: "stripe_connect_retired" };
}
