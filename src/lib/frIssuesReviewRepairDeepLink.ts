/**
 * FR Issues → Review & repair deep-link helpers (open existing panel only).
 */
import {
  DRIVER_FINANCIAL_REPAIR_COPY,
  isFrIssueEligibleForReviewRepair,
} from '../../shared/driverFinancialReviewRepairSSOT';

export type FrReviewRepairDeepLinkTarget = {
  driverId: string;
  tripId: string;
  tripCode?: string | null;
  driverName?: string | null;
  driverCode?: string | null;
};

export function frIssueReviewRepairButtonLabel(): string {
  return DRIVER_FINANCIAL_REPAIR_COPY.BUTTON;
}

export function resolveFrIssueReviewRepairDeepLink(issue: {
  issue_type?: string | null;
  driver_id?: string | null;
  trip_id?: string | null;
  trip_code?: string | null;
  driver_name?: string | null;
  driver_credit_health?: string | null;
  status?: string | null;
  expected_stamp_status?: string | null;
}): FrReviewRepairDeepLinkTarget | null {
  if (!isFrIssueEligibleForReviewRepair(issue)) return null;
  return {
    driverId: String(issue.driver_id),
    tripId: String(issue.trip_id),
    tripCode: issue.trip_code ?? null,
    driverName: issue.driver_name ?? null,
  };
}

/** Opening the panel must never auto-invoke Preview or Apply. */
export function frReviewRepairDeepLinkAutoPreview(): false {
  return false;
}
