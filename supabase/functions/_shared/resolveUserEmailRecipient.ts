/**
 * Backend-only recipient resolver SSOT.
 * Fail closed. No company/driver/admin/env/batch fallbacks.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  assertPersonalEndUserEmail,
  classifyExistingPersonalEmail,
  normalizePersonalEmail,
} from "./personalEmailPolicy.ts";

export type RecipientProfileType = "driver" | "customer" | "corporate" | "guest";

export type RecipientPurpose =
  | "email_change"
  | "signup_verification"
  | "password_reset"
  | "personal_trip_invoice"
  | "corporate_trip_invoice"
  | "guest_trip_invoice";

export type RecipientResolutionOk = {
  ok: true;
  userId: string;
  profileType: RecipientProfileType;
  profileId: string;
  recipientEmail: string;
  normalizedRecipientEmail: string;
  verificationState: "confirmed" | "pending_change" | "unverified" | "policy_violation";
  source: string;
  resolvedAt: string;
};

export type RecipientResolutionErr = {
  ok: false;
  code:
    | "MISSING_USER"
    | "MISSING_PROFILE"
    | "PROFILE_USER_MISMATCH"
    | "INVALID_EMAIL"
    | "RECIPIENT_POLICY_VIOLATION"
    | "RECIPIENT_MISSING"
    | "RECIPIENT_UNVERIFIED"
    | "TRIP_CUSTOMER_MISMATCH"
    | "AMBIGUOUS_OWNERSHIP"
    | "UNSUPPORTED_BOOKING_TYPE"
    | "CORPORATE_RECIPIENT_MISSING";
  message: string;
};

export type RecipientResolution = RecipientResolutionOk | RecipientResolutionErr;

export type ResolveUserEmailRecipientArgs = {
  authenticatedUserId?: string | null;
  /** When resolving for a trip/invoice, the owning auth user (may differ from caller). */
  subjectUserId?: string | null;
  purpose: RecipientPurpose;
  expectedProfileType: RecipientProfileType;
  expectedProfileId?: string | null;
  tripId?: string | null;
  bookingType?: "personal" | "corporate" | "guest" | null;
  /** For email_change: the intended new address (not yet Auth-confirmed). */
  pendingNewEmail?: string | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

async function loadDriverProfile(
  service: SupabaseClient,
  userId: string,
  expectedProfileId?: string | null,
): Promise<{ id: string; first_name: string | null; email: string | null } | null> {
  let query = service
    .from("drivers")
    .select("id, first_name, email, user_id")
    .eq("user_id", userId)
    .is("deleted_at", null);
  if (expectedProfileId) query = query.eq("id", expectedProfileId);
  const { data } = await query.maybeSingle();
  if (!data) return null;
  if (data.user_id !== userId) return null;
  return data;
}

async function loadCustomerProfile(
  service: SupabaseClient,
  userId: string,
  expectedProfileId?: string | null,
): Promise<{ id: string; first_name: string | null; email_verified: boolean | null } | null> {
  let query = service
    .from("customers")
    .select("id, first_name, email_verified, user_id")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (expectedProfileId) {
    query = service
      .from("customers")
      .select("id, first_name, email_verified, user_id")
      .eq("id", expectedProfileId)
      .is("deleted_at", null)
      .maybeSingle() as unknown as typeof query;
    const { data } = await service
      .from("customers")
      .select("id, first_name, email_verified, user_id")
      .eq("id", expectedProfileId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!data || data.user_id !== userId) return null;
    return data;
  }
  const { data } = await query.maybeSingle();
  if (!data || data.user_id !== userId) return null;
  return data;
}

/**
 * Resolve a personal Driver/Customer recipient. Corporate/guest use dedicated branches.
 */
export async function resolveUserEmailRecipient(
  service: SupabaseClient,
  args: ResolveUserEmailRecipientArgs,
): Promise<RecipientResolution> {
  const subjectUserId = (args.subjectUserId ?? args.authenticatedUserId ?? "").trim();
  if (!subjectUserId) {
    return { ok: false, code: "MISSING_USER", message: "Authenticated user is required." };
  }

  const bookingType = args.bookingType ??
    (args.purpose === "corporate_trip_invoice"
      ? "corporate"
      : args.purpose === "guest_trip_invoice"
      ? "guest"
      : "personal");

  if (bookingType === "corporate") {
    return resolveCorporateRecipient(service, args, subjectUserId);
  }
  if (bookingType === "guest") {
    return resolveGuestRecipient(service, args, subjectUserId);
  }

  if (
    args.expectedProfileType !== "driver" &&
    args.expectedProfileType !== "customer"
  ) {
    return {
      ok: false,
      code: "UNSUPPORTED_BOOKING_TYPE",
      message: "Unsupported personal profile type.",
    };
  }

  // Email-change: intended recipient is the pending new email, not current Auth.
  if (args.purpose === "email_change") {
    const pending = assertPersonalEndUserEmail(String(args.pendingNewEmail ?? ""), "email_change");
    if (!pending.ok) {
      return {
        ok: false,
        code: pending.code === "RECIPIENT_POLICY_VIOLATION"
          ? "RECIPIENT_POLICY_VIOLATION"
          : "INVALID_EMAIL",
        message: pending.message,
      };
    }

    if (args.expectedProfileType === "driver") {
      const driver = await loadDriverProfile(service, subjectUserId, args.expectedProfileId);
      if (!driver) {
        return { ok: false, code: "MISSING_PROFILE", message: "Driver profile not found." };
      }
      return {
        ok: true,
        userId: subjectUserId,
        profileType: "driver",
        profileId: driver.id,
        recipientEmail: pending.normalizedEmail,
        normalizedRecipientEmail: pending.normalizedEmail,
        verificationState: "pending_change",
        source: "email_change_request.new_email",
        resolvedAt: nowIso(),
      };
    }

    const customer = await loadCustomerProfile(service, subjectUserId, args.expectedProfileId);
    if (!customer) {
      return { ok: false, code: "MISSING_PROFILE", message: "Customer profile not found." };
    }
    return {
      ok: true,
      userId: subjectUserId,
      profileType: "customer",
      profileId: customer.id,
      recipientEmail: pending.normalizedEmail,
      normalizedRecipientEmail: pending.normalizedEmail,
      verificationState: "pending_change",
      source: "email_change_request.new_email",
      resolvedAt: nowIso(),
    };
  }

  const { data: authLookup, error: authErr } = await service.auth.admin.getUserById(subjectUserId);
  if (authErr || !authLookup?.user) {
    return { ok: false, code: "MISSING_USER", message: "Auth user not found." };
  }
  const authEmail = authLookup.user.email ?? null;
  const classified = classifyExistingPersonalEmail(authEmail);

  if (classified.status === "missing") {
    return { ok: false, code: "RECIPIENT_MISSING", message: "No confirmed email on the account." };
  }
  if (classified.status === "recipient_policy_violation") {
    return {
      ok: false,
      code: "RECIPIENT_POLICY_VIOLATION",
      message: "Account email violates personal recipient policy.",
    };
  }
  if (classified.status === "placeholder" || classified.status === "invalid") {
    return {
      ok: false,
      code: "INVALID_EMAIL",
      message: "Confirmed email is not a valid personal recipient.",
    };
  }

  if (args.expectedProfileType === "driver") {
    const driver = await loadDriverProfile(service, subjectUserId, args.expectedProfileId);
    if (!driver) {
      return { ok: false, code: "MISSING_PROFILE", message: "Driver profile not found." };
    }
    const verificationState = authLookup.user.email_confirmed_at
      ? "confirmed"
      : "unverified";
    if (
      (args.purpose === "personal_trip_invoice" || args.purpose === "password_reset") &&
      verificationState === "unverified"
    ) {
      return {
        ok: false,
        code: "RECIPIENT_UNVERIFIED",
        message: "Email must be verified before this action.",
      };
    }
    return {
      ok: true,
      userId: subjectUserId,
      profileType: "driver",
      profileId: driver.id,
      recipientEmail: classified.normalizedEmail!,
      normalizedRecipientEmail: classified.normalizedEmail!,
      verificationState,
      source: "auth.users.email",
      resolvedAt: nowIso(),
    };
  }

  const customer = await loadCustomerProfile(service, subjectUserId, args.expectedProfileId);
  if (!customer) {
    return { ok: false, code: "MISSING_PROFILE", message: "Customer profile not found." };
  }

  if (args.tripId) {
    const { data: trip } = await service
      .from("trips")
      .select("id, passenger_id")
      .eq("id", args.tripId)
      .maybeSingle();
    if (!trip) {
      return { ok: false, code: "TRIP_CUSTOMER_MISMATCH", message: "Trip not found." };
    }
    if (trip.passenger_id && trip.passenger_id !== customer.id && trip.passenger_id !== subjectUserId) {
      // Also allow passenger_id stored as auth user id historically.
      const { data: byPassenger } = await service
        .from("customers")
        .select("id, user_id")
        .eq("id", trip.passenger_id)
        .maybeSingle();
      if (!byPassenger || byPassenger.user_id !== subjectUserId) {
        return {
          ok: false,
          code: "TRIP_CUSTOMER_MISMATCH",
          message: "Trip does not belong to this customer.",
        };
      }
    }
  }

  return {
    ok: true,
    userId: subjectUserId,
    profileType: "customer",
    profileId: customer.id,
    recipientEmail: classified.normalizedEmail!,
    normalizedRecipientEmail: classified.normalizedEmail!,
    verificationState: authLookup.user.email_confirmed_at ? "confirmed" : "unverified",
    source: "auth.users.email",
    resolvedAt: nowIso(),
  };
}

async function resolveCorporateRecipient(
  service: SupabaseClient,
  args: ResolveUserEmailRecipientArgs,
  _subjectUserId: string,
): Promise<RecipientResolution> {
  if (!args.tripId && !args.expectedProfileId) {
    return {
      ok: false,
      code: "CORPORATE_RECIPIENT_MISSING",
      message: "Corporate booking requires trip or corporate account id.",
    };
  }

  // Prefer corporate account billing_email via trip → corporate booking linkage when present.
  if (args.tripId) {
    const { data: trip } = await service
      .from("trips")
      .select("id, passenger_id, corporate_account_id")
      .eq("id", args.tripId)
      .maybeSingle();

    const corporateAccountId = (trip as { corporate_account_id?: string | null } | null)
      ?.corporate_account_id ?? args.expectedProfileId ?? null;

    if (!corporateAccountId) {
      return {
        ok: false,
        code: "UNSUPPORTED_BOOKING_TYPE",
        message: "Trip is not linked to a corporate account.",
      };
    }

    const { data: account } = await service
      .from("corporate_accounts")
      .select("id, billing_email, contact_email")
      .eq("id", corporateAccountId)
      .maybeSingle();

    const billing = normalizePersonalEmail(
      String(account?.billing_email ?? account?.contact_email ?? ""),
    );
    if (!billing || !billing.includes("@")) {
      return {
        ok: false,
        code: "CORPORATE_RECIPIENT_MISSING",
        message: "Corporate billed-party email is missing.",
      };
    }
    // Corporate may use external company domains; still block ONECAB internal ops mailboxes
    // unless the account is genuinely ONECAB-owned (not implemented as silent allow).
    const personalCheck = assertPersonalEndUserEmail(billing);
    if (!personalCheck.ok && personalCheck.code === "RECIPIENT_POLICY_VIOLATION") {
      return {
        ok: false,
        code: "RECIPIENT_POLICY_VIOLATION",
        message: "ONECAB internal mailbox cannot be used as corporate billed party.",
      };
    }

    return {
      ok: true,
      userId: _subjectUserId,
      profileType: "corporate",
      profileId: corporateAccountId,
      recipientEmail: billing,
      normalizedRecipientEmail: billing,
      verificationState: "confirmed",
      source: "corporate_accounts.billing_email",
      resolvedAt: nowIso(),
    };
  }

  return {
    ok: false,
    code: "CORPORATE_RECIPIENT_MISSING",
    message: "Corporate recipient could not be resolved.",
  };
}

async function resolveGuestRecipient(
  service: SupabaseClient,
  args: ResolveUserEmailRecipientArgs,
  subjectUserId: string,
): Promise<RecipientResolution> {
  if (!args.tripId) {
    return {
      ok: false,
      code: "UNSUPPORTED_BOOKING_TYPE",
      message: "Guest booking requires trip id.",
    };
  }
  const { data: trip } = await service
    .from("trips")
    .select("id, booking_source, passenger_id, fare_snapshot_json")
    .eq("id", args.tripId)
    .maybeSingle();

  if (!trip || String((trip as { booking_source?: string }).booking_source ?? "").toLowerCase() !== "guest") {
    return {
      ok: false,
      code: "UNSUPPORTED_BOOKING_TYPE",
      message: "Trip is not a guest booking.",
    };
  }

  // Explicit guest email must live on the booking contract — never fall back to Driver/Admin/company.
  const snap = (trip as { fare_snapshot_json?: Record<string, unknown> | null }).fare_snapshot_json;
  const guestEmailRaw = String(
    snap?.guest_email ??
      snap?.booking_email ??
      snap?.passenger_email ??
      "",
  );
  const validated = assertPersonalEndUserEmail(guestEmailRaw);
  if (!validated.ok) {
    return {
      ok: false,
      code: validated.code === "RECIPIENT_POLICY_VIOLATION"
        ? "RECIPIENT_POLICY_VIOLATION"
        : "RECIPIENT_MISSING",
      message: validated.message || "Guest booking email is missing or invalid.",
    };
  }
  return {
    ok: true,
    userId: subjectUserId,
    profileType: "guest",
    profileId: args.expectedProfileId ?? args.tripId,
    recipientEmail: validated.normalizedEmail,
    normalizedRecipientEmail: validated.normalizedEmail,
    verificationState: "confirmed",
    source: "trip.fare_snapshot_json.guest_email",
    resolvedAt: nowIso(),
  };
}
