/**
 * P0 App Performance Health Control — SSOT for p95 targets, timeout budgets, and status.
 *
 * Rule: p95 target is the performance goal. Timeout is only the safety ceiling.
 */

export type PerformanceApp = 'customer_app' | 'driver_app' | 'admin_web';
export type PerformancePlatform = 'ios' | 'android' | 'web';
export type PerformanceFlowType =
  | 'single_trip'
  | 'multi_stop'
  | 'booking'
  | 'cancellation'
  | 'payment'
  | 'notification_tap'
  | 'warm_resume'
  | 'backend_edge'
  | 'admin_panel';

export type PerformanceStatus =
  | 'OK'
  | 'PERF_WARNING'
  | 'PERF_REGRESSION'
  | 'PERF_TIMEOUT'
  | 'FAILED';

export type DriverPerformanceAction =
  | 'driver_accept_ride'
  | 'driver_arrive_pickup'
  | 'driver_start_trip'
  | 'driver_complete_trip'
  | 'driver_arrive_stop'
  | 'driver_drive_next'
  | 'driver_complete_multistop'
  | 'driver_open_cancel_sheet'
  | 'driver_submit_cancel'
  | 'driver_cancel_success'
  | 'driver_notification_tap_to_offer_card'
  | 'driver_notification_tap_to_active_trip'
  | 'driver_resume_to_trip_ready';

export type CustomerPerformanceAction =
  | 'customer_open_payment_sheet'
  | 'customer_select_card'
  | 'customer_add_card_setup'
  | 'customer_request_ride'
  | 'customer_create_booking'
  | 'customer_booking_success'
  | 'customer_open_cancel_sheet'
  | 'customer_submit_cancel'
  | 'customer_cancel_success'
  | 'customer_open_active_trip'
  | 'customer_trip_update_render'
  | 'customer_rematch_state_render'
  | 'customer_open_trip_modification_sheet'
  | 'customer_modification_realtime_card_update'
  | 'customer_waiting_time_tick_latency'
  | 'customer_payment_method_loaded'
  | 'customer_payment_gateway_resolved'
  | 'customer_payment_provider_ready';

export type BackendPerformanceAction =
  | 'edge_accept_offer'
  | 'edge_stop_workflow'
  | 'edge_create_ride'
  | 'edge_create_preauth_payment_intent'
  | 'edge_setup_card'
  | 'edge_cancel_trip'
  | 'edge_create_trip_after_payment'
  | 'edge_request_trip_modification'
  | 'edge_respond_trip_modification'
  | 'edge_resolve_service_area'
  | 'edge_estimate_fare'
  | 'edge_get_active_trip';

/**
 * Admin Panel — one action per tracked page load/refresh/save.
 * NOTE: as of 2026-07-06, only three of these have a real page to instrument:
 * admin_dashboard_load (AppHealthOverview.tsx — the closest existing stand-in
 * for a landing/overview screen; there is no single post-login admin home
 * page in either repo), admin_document_management_load (DocumentManagement.tsx),
 * and admin_service_area_save (ServiceAreaMarketplace.tsx). The remaining four
 * (financial reconciliation, driver wallet ledger, payment providers, staff
 * work patterns) do not have an existing admin page in either repo — these
 * action names/targets are defined now so the schema, dashboard, and client
 * helper are ready the moment those pages are built, but there is nothing to
 * wire them into yet. See APP_PERFORMANCE_P95_BEFORE_AFTER_VERDICT_REPORT.md.
 */
export type AdminPerformanceAction =
  | 'admin_dashboard_load'
  | 'admin_financial_reconciliation_load'
  | 'admin_driver_wallet_ledger_load'
  | 'admin_active_trips_load'
  | 'admin_payment_providers_refresh'
  | 'admin_service_area_save'
  | 'admin_document_management_load'
  | 'admin_staff_work_patterns_load';

export type PerformanceActionName =
  | DriverPerformanceAction
  | CustomerPerformanceAction
  | BackendPerformanceAction
  | AdminPerformanceAction;

/** p95 latency targets (ms) */
export const P95_TARGET_MS: Record<PerformanceActionName, number> = {
  driver_accept_ride: 1_500,
  driver_arrive_pickup: 1_500,
  driver_start_trip: 1_500,
  driver_complete_trip: 2_000,
  driver_arrive_stop: 1_500,
  driver_drive_next: 1_500,
  driver_complete_multistop: 2_000,
  driver_open_cancel_sheet: 1_500,
  driver_submit_cancel: 1_500,
  driver_cancel_success: 1_500,
  driver_notification_tap_to_offer_card: 2_000,
  driver_notification_tap_to_active_trip: 2_000,
  driver_resume_to_trip_ready: 2_000,
  customer_open_payment_sheet: 1_500,
  customer_select_card: 1_500,
  customer_add_card_setup: 2_000,
  customer_request_ride: 2_000,
  customer_create_booking: 5_000,
  customer_booking_success: 5_000,
  customer_open_cancel_sheet: 1_000,
  customer_submit_cancel: 1_500,
  customer_cancel_success: 1_500,
  customer_open_active_trip: 1_500,
  customer_trip_update_render: 1_500,
  customer_rematch_state_render: 1_500,
  customer_open_trip_modification_sheet: 1_500,
  customer_modification_realtime_card_update: 2_000,
  customer_waiting_time_tick_latency: 1_500,
  customer_payment_method_loaded: 1_500,
  customer_payment_gateway_resolved: 1_500,
  customer_payment_provider_ready: 2_000,
  edge_accept_offer: 1_500,
  edge_stop_workflow: 1_500,
  edge_create_ride: 5_000,
  edge_create_preauth_payment_intent: 2_000,
  edge_setup_card: 2_000,
  edge_cancel_trip: 1_500,
  edge_create_trip_after_payment: 5_000,
  edge_request_trip_modification: 1_500,
  edge_respond_trip_modification: 1_500,
  edge_resolve_service_area: 1_500,
  edge_estimate_fare: 2_000,
  edge_get_active_trip: 1_500,
  admin_dashboard_load: 2_000,
  admin_financial_reconciliation_load: 3_000,
  admin_driver_wallet_ledger_load: 3_000,
  admin_active_trips_load: 3_000,
  admin_payment_providers_refresh: 2_000,
  admin_service_area_save: 2_000,
  admin_document_management_load: 2_000,
  admin_staff_work_patterns_load: 2_500,
};

/** Timeout safety ceilings (ms) — not performance targets */
export const TIMEOUT_BUDGET_MS = {
  driver_trip_action: 10_000,
  customer_sheet_open: 8_000,
  payment_sheet_setup: 20_000,
  booking_attempt: 45_000,
  cancel_action: 15_000,
  backend_edge_default: 30_000,
  admin_panel_default: 12_000,
} as const;

export function timeoutBudgetForAction(action: PerformanceActionName): number {
  if (action.startsWith('driver_') && !action.includes('cancel_sheet')) {
    if (action === 'driver_open_cancel_sheet' || action === 'driver_submit_cancel') {
      return TIMEOUT_BUDGET_MS.cancel_action;
    }
    return TIMEOUT_BUDGET_MS.driver_trip_action;
  }
  if (action.startsWith('customer_open_') || action.includes('_sheet')) {
    if (action.includes('payment') || action.includes('add_card')) {
      return TIMEOUT_BUDGET_MS.payment_sheet_setup;
    }
    return TIMEOUT_BUDGET_MS.customer_sheet_open;
  }
  if (action.startsWith('customer_') && (action.includes('cancel') || action.includes('submit'))) {
    return TIMEOUT_BUDGET_MS.cancel_action;
  }
  if (
    action === 'customer_create_booking'
    || action === 'customer_booking_success'
    || action === 'customer_request_ride'
  ) {
    return TIMEOUT_BUDGET_MS.booking_attempt;
  }
  if (action.startsWith('edge_')) {
    if (action.includes('create') || action.includes('booking')) {
      return TIMEOUT_BUDGET_MS.booking_attempt;
    }
    return TIMEOUT_BUDGET_MS.backend_edge_default;
  }
  if (action.startsWith('admin_')) {
    return TIMEOUT_BUDGET_MS.admin_panel_default;
  }
  return TIMEOUT_BUDGET_MS.driver_trip_action;
}

export function evaluatePerformanceStatus(params: {
  duration_ms: number;
  p95_target_ms: number;
  timeout_budget_ms: number;
  success: boolean;
  timed_out?: boolean;
}): PerformanceStatus {
  const duration = Math.max(0, Math.round(params.duration_ms));
  const { p95_target_ms, timeout_budget_ms, success, timed_out } = params;

  if (!success) {
    if (timed_out || duration >= timeout_budget_ms) return 'PERF_TIMEOUT';
    return 'FAILED';
  }
  if (timed_out || duration >= timeout_budget_ms) return 'PERF_TIMEOUT';
  if (duration >= timeout_budget_ms * 0.8) return 'PERF_REGRESSION';
  if (duration > p95_target_ms) return 'PERF_WARNING';
  return 'OK';
}

export type RecordPerformanceStepInput = {
  app: PerformanceApp;
  platform?: PerformancePlatform | string | null;
  service_area_id?: string | null;
  region_id?: string | null;
  trip_id?: string | null;
  action_name: PerformanceActionName;
  flow_type?: PerformanceFlowType | string | null;
  started_at?: number | string | null;
  completed_at?: number | string | null;
  duration_ms?: number;
  success: boolean;
  error_code?: string | null;
  timeout_budget_ms?: number;
  p95_target_ms?: number;
  device_model?: string | null;
  os_version?: string | null;
  app_version?: string | null;
  user_id?: string | null;
  metadata?: Record<string, unknown>;
  timed_out?: boolean;
};

export type PerformanceStepResult = {
  duration_ms: number;
  p95_target_ms: number;
  timeout_budget_ms: number;
  performance_status: PerformanceStatus;
};

export function resolvePerformanceStepTiming(input: RecordPerformanceStepInput): PerformanceStepResult {
  const p95_target_ms = input.p95_target_ms ?? P95_TARGET_MS[input.action_name] ?? 2_000;
  const timeout_budget_ms =
    input.timeout_budget_ms ?? timeoutBudgetForAction(input.action_name);

  let duration_ms = input.duration_ms;
  if (duration_ms == null && input.started_at != null && input.completed_at != null) {
    const start =
      typeof input.started_at === 'number'
        ? input.started_at
        : new Date(input.started_at).getTime();
    const end =
      typeof input.completed_at === 'number'
        ? input.completed_at
        : new Date(input.completed_at).getTime();
    duration_ms = end - start;
  }
  duration_ms = Math.max(0, Math.round(duration_ms ?? 0));

  const performance_status = evaluatePerformanceStatus({
    duration_ms,
    p95_target_ms,
    timeout_budget_ms,
    success: input.success,
    timed_out: input.timed_out,
  });

  return { duration_ms, p95_target_ms, timeout_budget_ms, performance_status };
}

export function driverActionFromWorkflowAction(
  action: string,
  stopCount?: number,
): DriverPerformanceAction {
  switch (action) {
    case 'arrive_pickup':
      return 'driver_arrive_pickup';
    case 'start_trip':
      return 'driver_start_trip';
    case 'arrive_stop':
      return 'driver_arrive_stop';
    case 'next_stop':
    case 'drive_to_next':
      return 'driver_drive_next';
    case 'complete_trip':
      return (stopCount ?? 0) > 2 ? 'driver_complete_multistop' : 'driver_complete_trip';
    default:
      return 'driver_start_trip';
  }
}

export const EDGE_FUNCTION_PERF_ACTION: Record<string, BackendPerformanceAction> = {
  'accept-offer': 'edge_accept_offer',
  'stop-workflow': 'edge_stop_workflow',
  'create-ride': 'edge_create_ride',
  'create-preauth-payment-intent': 'edge_create_preauth_payment_intent',
  'setup-card': 'edge_setup_card',
  'cancel-trip': 'edge_cancel_trip',
  'create-trip-after-payment': 'edge_create_trip_after_payment',
  'request-trip-modification': 'edge_request_trip_modification',
  'respond-trip-modification': 'edge_respond_trip_modification',
  'resolve-service-area': 'edge_resolve_service_area',
  'estimate-fare': 'edge_estimate_fare',
  'get-active-trip': 'edge_get_active_trip',
};
