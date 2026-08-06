/**
 * Call masking phone routing SSOT (edge).
 * Client flow + constants: shared/callMaskingSsot.ts
 */

/** Default region for local numbers without country code (OneCab UK). */
const DEFAULT_COUNTRY_CODE = "44";

/**
 * Normalize to E.164 digits only (no +), e.g. +447491376424 → 447491376424.
 * UK local 07… → 447….
 */
export function normalizePhoneE164Digits(
  phone: string,
  defaultCountryCode = DEFAULT_COUNTRY_CODE,
): string {
  let digits = phone.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);

  // Already international (e.g. 447…, 1…)
  if (digits.length >= 11 && !digits.startsWith("0")) {
    return digits;
  }

  // UK local mobile/landline: 0XXXXXXXXXX → 44XXXXXXXXXX
  if (
    defaultCountryCode === "44" &&
    digits.startsWith("0") &&
    digits.length >= 10 &&
    digits.length <= 11
  ) {
    return `44${digits.slice(1)}`;
  }

  // Bare national number without leading 0
  if (digits.length >= 9 && digits.length <= 10 && defaultCountryCode) {
    return `${defaultCountryCode}${digits}`;
  }

  return digits;
}

/** E.164 with leading + for display/storage, e.g. +447491376424 */
export function toE164(phone: string, defaultCountryCode = DEFAULT_COUNTRY_CODE): string {
  const digits = normalizePhoneE164Digits(phone, defaultCountryCode);
  return digits ? `+${digits}` : "";
}

export function phonesMatch(
  a: string,
  b: string,
  defaultCountryCode = DEFAULT_COUNTRY_CODE,
): boolean {
  const da = normalizePhoneE164Digits(a, defaultCountryCode);
  const db = normalizePhoneE164Digits(b, defaultCountryCode);
  return Boolean(da && db && da === db);
}

export type CallRoute = {
  caller: string;
  destination: string;
  callerRole: "driver" | "customer";
};

/**
 * If caller is driver → connect customer; if caller is customer → connect driver.
 * Never returns caller as destination.
 */
export function resolveCallRoute(
  callerPhone: string,
  driverPhone: string,
  customerPhone: string,
  defaultCountryCode = DEFAULT_COUNTRY_CODE,
): CallRoute | null {
  const callerE = normalizePhoneE164Digits(callerPhone, defaultCountryCode);
  const driverE = normalizePhoneE164Digits(driverPhone, defaultCountryCode);
  const customerE = normalizePhoneE164Digits(customerPhone, defaultCountryCode);

  if (!callerE || !driverE || !customerE) return null;

  if (callerE === driverE) {
    if (driverE === customerE) return null;
    return {
      caller: toE164(driverPhone, defaultCountryCode),
      destination: toE164(customerPhone, defaultCountryCode),
      callerRole: "driver",
    };
  }

  if (callerE === customerE) {
    if (driverE === customerE) return null;
    return {
      caller: toE164(customerPhone, defaultCountryCode),
      destination: toE164(driverPhone, defaultCountryCode),
      callerRole: "customer",
    };
  }

  return null;
}

export type InboundSessionRow = {
  id: string;
  trip_id: string;
  driver_id: string;
  driver_phone: string;
  customer_phone: string;
  caller_id: string | null;
  msg91_request_id?: string | null;
  status: string;
  expires_at: string | null;
  updated_at?: string;
};

export type InboundTripRow = {
  id: string;
  status: string;
  completed_at: string | null;
  confirmed_driver_id: string | null;
};

export type InboundSessionPick = {
  session: InboundSessionRow;
  trip: InboundTripRow;
  route: CallRoute;
};

/**
 * Pick the best active masking session for an inbound virtual-number call.
 * Prefers trips still in a callable status; skips stale driver assignments.
 */
export function pickInboundMaskingSession(
  callerPhone: string,
  virtualNumber: string,
  defaultVirtualNumber: string,
  sessions: InboundSessionRow[],
  tripById: Map<string, InboundTripRow>,
  isSessionValid: (session: InboundSessionRow, trip: InboundTripRow) => boolean,
  callableStatuses: ReadonlySet<string>,
): InboundSessionPick | null {
  const matches: InboundSessionPick[] = [];

  for (const row of sessions) {
    const route = resolveCallRoute(callerPhone, row.driver_phone, row.customer_phone);
    if (!route) continue;

    const virtualOk =
      phonesMatch(virtualNumber, row.caller_id ?? defaultVirtualNumber) ||
      phonesMatch(virtualNumber, defaultVirtualNumber);
    if (!virtualOk) continue;

    const trip = tripById.get(row.trip_id);
    if (!trip || !isSessionValid(row, trip)) continue;

    if (trip.confirmed_driver_id && row.driver_id !== trip.confirmed_driver_id) {
      continue;
    }

    matches.push({ session: row, trip, route });
  }

  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    const aCallable = callableStatuses.has(a.trip.status) ? 1 : 0;
    const bCallable = callableStatuses.has(b.trip.status) ? 1 : 0;
    return bCallable - aCallable;
  });

  return matches[0];
}
