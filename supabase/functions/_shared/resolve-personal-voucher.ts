import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

export type PersonalVoucherRow = {
  id: string;
  customer_id: string;
  code: string;
  discount_type: "fixed" | "percent";
  discount_value: number;
  min_fare: number;
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  is_active: boolean;
};

export type PersonalVoucherValidationError =
  | "not_found"
  | "not_assigned"
  | "expired"
  | "inactive"
  | "usage_limit"
  | "min_fare";

export const PERSONAL_VOUCHER_ERROR_MESSAGES: Record<PersonalVoucherValidationError, string> = {
  not_found: "Invalid voucher code",
  not_assigned: "This voucher is not assigned to your account.",
  expired: "Voucher expired",
  inactive: "Voucher inactive",
  usage_limit: "Usage limit reached",
  min_fare: "Minimum fare not met",
};

export interface ResolvedPersonalVoucher {
  voucherId: string;
  voucherCode: string;
  discountPence: number;
  finalFarePence: number;
}

export function calcDiscountPence(voucher: PersonalVoucherRow, farePence: number): number {
  if (farePence <= 0) return 0;
  let raw = 0;
  if (voucher.discount_type === "percent") {
    raw = Math.floor((farePence * Number(voucher.discount_value)) / 100);
  } else {
    raw = Math.round(Number(voucher.discount_value) * 100);
  }
  return Math.max(0, Math.min(raw, farePence));
}

export function validatePersonalVoucherRow(
  voucher: PersonalVoucherRow | null,
  opts: { customerId: string; farePence: number },
): PersonalVoucherValidationError | null {
  if (!voucher) return "not_found";
  if (voucher.customer_id !== opts.customerId) return "not_assigned";
  if (!voucher.is_active) return "inactive";
  if (voucher.used_count >= voucher.max_uses) return "usage_limit";
  if (voucher.expires_at && new Date(voucher.expires_at).getTime() <= Date.now()) return "expired";
  const minFarePence = Math.round(Number(voucher.min_fare) * 100);
  if (opts.farePence < minFarePence) return "min_fare";
  return null;
}

export async function lookupPersonalVoucherByCode(
  admin: SupabaseClient,
  code: string,
): Promise<PersonalVoucherRow | null> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return null;

  const { data, error } = await admin
    .from("customer_personal_vouchers")
    .select(
      "id,customer_id,code,discount_type,discount_value,min_fare,max_uses,used_count,expires_at,is_active",
    )
    .eq("code", normalized)
    .maybeSingle();

  if (error) {
    console.warn("[personal-voucher] lookup failed", error.message);
    return null;
  }
  return (data as PersonalVoucherRow | null) ?? null;
}

export async function resolvePersonalVoucherForTrip(opts: {
  admin: SupabaseClient;
  code: string;
  customerId: string;
  estimatedFarePence: number;
}): Promise<
  | { ok: true; resolved: ResolvedPersonalVoucher }
  | { ok: false; error: PersonalVoucherValidationError }
> {
  const farePence = Math.max(0, Math.floor(Number(opts.estimatedFarePence) || 0));
  const voucher = await lookupPersonalVoucherByCode(opts.admin, opts.code);
  const validationError = validatePersonalVoucherRow(voucher, {
    customerId: opts.customerId,
    farePence,
  });
  if (validationError || !voucher) {
    return { ok: false, error: validationError ?? "not_found" };
  }

  const discountPence = calcDiscountPence(voucher, farePence);
  return {
    ok: true,
    resolved: {
      voucherId: voucher.id,
      voucherCode: voucher.code,
      discountPence,
      finalFarePence: Math.max(0, farePence - discountPence),
    },
  };
}

export async function consumePersonalVoucherForTrip(
  admin: SupabaseClient,
  tripId: string,
  voucherId: string | null | undefined,
): Promise<boolean> {
  if (!voucherId) return false;
  const { data, error } = await admin.rpc("consume_personal_voucher", {
    p_voucher_id: voucherId,
    p_trip_id: tripId,
  });
  if (error) {
    console.warn("[personal-voucher] consume failed", { tripId, voucherId, error: error.message });
    return false;
  }
  return data === true;
}
