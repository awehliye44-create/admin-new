/**
 * Provider-neutral driver identity verification types.
 * Veriff-specific shapes must stay inside the Veriff adapter.
 */

export type OnecabIdentityStatus =
  | "required"
  | "deferred_active_work"
  | "started"
  | "processing"
  | "approved"
  | "retry_required"
  | "manual_review"
  | "rejected"
  | "expired"
  | "cancelled"
  | "reference_unavailable";

export type OnecabIdentityReason =
  | "periodic_check"
  | "random_check"
  | "new_device"
  | "suspicious_login"
  | "unusual_location"
  | "admin_requested"
  | "expired_verification"
  | "account_reactivation"
  | "risk_rule"
  | "provider_retry";

export type OnecabIdentityDecision =
  | "approved"
  | "rejected"
  | "retry_required"
  | "manual_review"
  | "expired"
  | "cancelled";

export type AppFacingIdentityState =
  | "checking"
  | "approved"
  | "retry_required"
  | "manual_review"
  | "rejected"
  | "expired"
  | "network_error"
  | "reference_unavailable"
  | "deferred_active_work"
  | "required";

export type IdentityReferenceResolution =
  | {
    status: "available";
    source: "driver_profile_photo" | "approved_profile_photo_document";
    privateObjectPath: string;
    contentType: string;
    approvedAt: string;
  }
  | {
    status: "unavailable";
    reason:
      | "missing"
      | "untrusted_source"
      | "not_approved"
      | "unsupported_format"
      | "quality_not_confirmed"
      | "consent_or_provenance_missing";
  };

export type CreateIdentitySessionInput = {
  driverId: string;
  endUserId: string;
  firstName?: string | null;
  lastName?: string | null;
  vendorData: string;
  workflowId?: string | null;
  reference: Extract<IdentityReferenceResolution, { status: "available" }>;
  /** Raw image bytes already fetched server-side (never from client). */
  referenceImageBytes: Uint8Array;
  referenceContentType: string;
};

export type CreateIdentitySessionResult = {
  provider: string;
  providerSessionId: string;
  sessionUrl: string;
  expiresAt?: string | null;
};

export type ProviderIdentityDecision = {
  providerSessionId: string;
  decision: OnecabIdentityDecision;
  livenessResult?: string | null;
  faceMatchResult?: string | null;
  imageQualityResult?: string | null;
  failureCode?: string | null;
  rawDecisionCode?: string | null;
  decidedAt?: string | null;
};

export type RawWebhookInput = {
  rawBody: string;
  headers: Headers;
};

export type VerifiedProviderWebhookEvent = {
  providerEventId: string;
  providerSessionId: string;
  kind: "progress" | "decision";
  progressStatus?: "started" | "submitted";
  decision?: ProviderIdentityDecision;
};

export type ProviderDecisionPayload = {
  status: string;
  code?: string | null;
  reasonCode?: string | null;
  declinedMapsTo?: "rejected" | "manual_review" | "retry_required";
  livenessResult?: string | null;
  faceMatchResult?: string | null;
  imageQualityResult?: string | null;
  decidedAt?: string | null;
  providerSessionId: string;
};

export interface DriverIdentityProvider {
  createSession(
    input: CreateIdentitySessionInput,
  ): Promise<CreateIdentitySessionResult>;

  getDecision(providerSessionId: string): Promise<ProviderIdentityDecision>;

  verifyWebhook(
    input: RawWebhookInput,
  ): Promise<VerifiedProviderWebhookEvent>;

  mapDecision(input: ProviderDecisionPayload): OnecabIdentityDecision;
}

export function mapInternalStatusToAppFacing(
  status: OnecabIdentityStatus | null | undefined,
): AppFacingIdentityState {
  switch (status) {
    case "approved":
      return "approved";
    case "retry_required":
      return "retry_required";
    case "manual_review":
      return "manual_review";
    case "rejected":
      return "rejected";
    case "expired":
      return "expired";
    case "reference_unavailable":
      return "reference_unavailable";
    case "deferred_active_work":
      return "deferred_active_work";
    case "processing":
    case "started":
      return "checking";
    case "required":
      return "required";
    case "cancelled":
      return "retry_required";
    default:
      return "network_error";
  }
}
