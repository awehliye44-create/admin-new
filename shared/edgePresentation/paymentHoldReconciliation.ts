/** Admin presentation-only helpers; not part of Edge uploads. */


export type AdminHoldActionRequest = {
  payment_session_id?: string;
  provider_order_id?: string;
  action: "release" | "retry_release" | "retry_recovery";
  dry_run?: boolean;
};


export const ADMIN_HOLD_ACTION_FN = "admin-hold-action";
