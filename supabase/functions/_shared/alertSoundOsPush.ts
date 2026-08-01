/**
 * Server-side allowlisted OS push contracts for Driver + Customer native installs.
 *
 * Authoritative mirrors (do not invent IDs):
 * - onecab-driver-native/.../alertEventRegistry.ts
 * - onecab-customer-native/.../alertEventRegistry.ts
 *
 * Unknown app+event combinations fail safely. Never emit remote URLs, storage
 * paths, or channel IDs as APNs/FCM sound filenames.
 */

/** Live Driver NRO channel — matches NEW_RIDE_OFFERS_CHANNEL_ID. */
export const DRIVER_NEW_RIDE_OFFER_ANDROID_CHANNEL_ID = "onecab_new_ride_offers_v1";
/** Canonical bundled iOS NRO sound — never ride_offer_alert.caf. */
export const DRIVER_NEW_RIDE_OFFER_IOS_SOUND = "onecab_new_ride_offer.wav";
export const DRIVER_NEW_RIDE_OFFER_IOS_CATEGORY = "ONECAB_NEW_RIDE_OFFER";

/** Live Customer trip-updates channel — matches CUSTOMER_UPDATES_CHANNEL_ID. */
export const CUSTOMER_LIVE_TRIP_UPDATES_CHANNEL_ID = "onecab_customer_updates_v1";
export const CUSTOMER_MESSAGES_CHANNEL_ID = "onecab_customer_messages_v1";
export const CUSTOMER_GENERAL_CHANNEL_ID = "onecab_customer_general_v1";

export type OsPushAppRole = "driver" | "customer";
export type OsInterruptionLevel = "time-sensitive" | "active";

export type OsPushContract = {
  appRole: OsPushAppRole;
  adminEventKey: string;
  canonicalKey: string;
  channelId: string;
  /** Local bundled filename only (e.g. onecab_new_ride_offer.wav). */
  sound: string;
  category: string;
  interruptionLevel: OsInterruptionLevel;
  deepLink: string;
};

export type OsPushSoundFields = {
  channelId: string;
  sound: string;
  category: string;
  interruptionLevel: OsInterruptionLevel;
  deepLink: string;
  adminEventKey: string;
  canonicalKey: string;
};

export type ResolveOsPushOk = { ok: true; contract: OsPushContract };
export type ResolveOsPushErr = {
  ok: false;
  code: "UNKNOWN_EVENT" | "UNSUPPORTED_APP_EVENT";
  eventKey: string;
};
export type ResolveOsPushResult = ResolveOsPushOk | ResolveOsPushErr;

type CustomerRegistryEntry = {
  adminEventKey: string;
  canonicalKey: string;
  channelId: string;
  sound: string;
  category: string;
  interruptionLevel: OsInterruptionLevel;
  deepLink: string;
};

/** Customer allowlist — matches native registry (payment_status reuses general WAV). */
const CUSTOMER_OS_PUSH_BY_ADMIN: ReadonlyMap<string, CustomerRegistryEntry> = new Map([
  [
    "driver_assigned",
    {
      adminEventKey: "driver_assigned",
      canonicalKey: "DRIVER_ASSIGNED",
      channelId: CUSTOMER_LIVE_TRIP_UPDATES_CHANNEL_ID,
      sound: "driver_assigned.wav",
      category: "ONECAB_DRIVER_ASSIGNED",
      interruptionLevel: "time-sensitive",
      deepLink: "/",
    },
  ],
  [
    "driver_arrived",
    {
      adminEventKey: "driver_arrived",
      canonicalKey: "DRIVER_ARRIVED",
      channelId: CUSTOMER_LIVE_TRIP_UPDATES_CHANNEL_ID,
      sound: "driver_arrived.wav",
      category: "ONECAB_DRIVER_ARRIVED",
      interruptionLevel: "time-sensitive",
      deepLink: "/",
    },
  ],
  [
    "trip_started",
    {
      adminEventKey: "trip_started",
      canonicalKey: "TRIP_STARTED",
      channelId: CUSTOMER_LIVE_TRIP_UPDATES_CHANNEL_ID,
      sound: "trip_started.wav",
      category: "ONECAB_TRIP_STARTED",
      interruptionLevel: "time-sensitive",
      deepLink: "/",
    },
  ],
  [
    "trip_completed",
    {
      adminEventKey: "trip_completed",
      canonicalKey: "TRIP_COMPLETED",
      channelId: CUSTOMER_LIVE_TRIP_UPDATES_CHANNEL_ID,
      sound: "trip_completed.wav",
      category: "ONECAB_TRIP_COMPLETED",
      interruptionLevel: "active",
      deepLink: "/",
    },
  ],
  [
    "trip_cancelled",
    {
      adminEventKey: "trip_cancelled",
      canonicalKey: "TRIP_CANCELLED",
      channelId: CUSTOMER_LIVE_TRIP_UPDATES_CHANNEL_ID,
      sound: "trip_cancelled.wav",
      category: "ONECAB_TRIP_CANCELLED",
      interruptionLevel: "time-sensitive",
      deepLink: "/",
    },
  ],
  [
    "message_received",
    {
      adminEventKey: "message_received",
      canonicalKey: "MESSAGE_RECEIVED",
      channelId: CUSTOMER_MESSAGES_CHANNEL_ID,
      sound: "message_received.wav",
      category: "ONECAB_MESSAGE_RECEIVED",
      interruptionLevel: "active",
      deepLink: "/booking/trip-chat",
    },
  ],
  [
    "payment_status",
    {
      adminEventKey: "payment_status",
      canonicalKey: "PAYMENT_STATUS",
      channelId: CUSTOMER_GENERAL_CHANNEL_ID,
      sound: "general_notification.wav",
      category: "ONECAB_GENERAL_NOTIFICATION",
      interruptionLevel: "active",
      deepLink: "/",
    },
  ],
  [
    "general_notification",
    {
      adminEventKey: "general_notification",
      canonicalKey: "GENERAL_NOTIFICATION",
      channelId: CUSTOMER_GENERAL_CHANNEL_ID,
      sound: "general_notification.wav",
      category: "ONECAB_GENERAL_NOTIFICATION",
      interruptionLevel: "active",
      deepLink: "/",
    },
  ],
]);

const CUSTOMER_PUSH_ALIASES: Record<string, string> = {
  DRIVER_ASSIGNED: "driver_assigned",
  driver_assigned: "driver_assigned",
  DRIVER_ARRIVED: "driver_arrived",
  driver_arrived: "driver_arrived",
  TRIP_STARTED: "trip_started",
  trip_started: "trip_started",
  TRIP_COMPLETED: "trip_completed",
  trip_completed: "trip_completed",
  TRIP_CANCELLED: "trip_cancelled",
  trip_cancelled: "trip_cancelled",
  MESSAGE_RECEIVED: "message_received",
  message_received: "message_received",
  PAYMENT_STATUS: "payment_status",
  payment_status: "payment_status",
  GENERAL_NOTIFICATION: "general_notification",
  general_notification: "general_notification",
};

const DRIVER_NRO_ALIASES = new Set([
  "new_ride_offer",
  "NEW_RIDE_OFFER",
  "stacked_ride_offer",
  "STACKED_RIDE_OFFER",
  "RIDE_OFFER",
  "ride_offer",
  "driver_new_ride_offer",
]);

export function isRemoteOrPathSound(sound: string | null | undefined): boolean {
  if (!sound) return false;
  const s = sound.trim();
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return true;
  if (s.includes("/")) return true;
  return false;
}

export function isLocalBundledSoundFilename(sound: string | null | undefined): boolean {
  if (!sound) return false;
  const s = sound.trim();
  if (!s || isRemoteOrPathSound(s)) return false;
  return /^[a-zA-Z0-9._-]+\.(wav|caf|aiff)$/i.test(s);
}

/** Obsolete per-event Customer channels previously invented by producers. */
export function isObsoleteCustomerChannelId(channelId: string | null | undefined): boolean {
  if (!channelId) return false;
  const id = channelId.trim();
  if (
    id === CUSTOMER_LIVE_TRIP_UPDATES_CHANNEL_ID ||
    id === CUSTOMER_MESSAGES_CHANNEL_ID ||
    id === CUSTOMER_GENERAL_CHANNEL_ID ||
    id === "onecab_customer_trip_updates_v1"
  ) {
    return false;
  }
  return /^onecab_customer_[a-z0-9_]+_v1$/i.test(id);
}

function driverRideOfferContract(adminEventKey: "new_ride_offer" | "stacked_ride_offer"): OsPushContract {
  return {
    appRole: "driver",
    adminEventKey,
    canonicalKey: adminEventKey === "stacked_ride_offer" ? "STACKED_RIDE_OFFER" : "NEW_RIDE_OFFER",
    channelId: DRIVER_NEW_RIDE_OFFER_ANDROID_CHANNEL_ID,
    sound: DRIVER_NEW_RIDE_OFFER_IOS_SOUND,
    category: DRIVER_NEW_RIDE_OFFER_IOS_CATEGORY,
    interruptionLevel: "time-sensitive",
    deepLink: "/",
  };
}

export function resolveDriverAdminEventKeyFromPushType(type: string): string | null {
  const t = type.trim();
  if (!t) return null;
  if (t === "stacked_ride_offer" || t === "STACKED_RIDE_OFFER") return "stacked_ride_offer";
  if (DRIVER_NRO_ALIASES.has(t) || t.toLowerCase().includes("ride_offer") || t.toLowerCase().includes("new_ride")) {
    return t === "stacked_ride_offer" || t === "STACKED_RIDE_OFFER" ? "stacked_ride_offer" : "new_ride_offer";
  }
  return null;
}

export function resolveDriverRideOfferOsPush(eventKey?: string | null): ResolveOsPushResult {
  const raw = (eventKey ?? "new_ride_offer").trim();
  const admin = resolveDriverAdminEventKeyFromPushType(raw);
  if (!admin) {
    return { ok: false, code: "UNKNOWN_EVENT", eventKey: raw };
  }
  return {
    ok: true,
    contract: driverRideOfferContract(admin as "new_ride_offer" | "stacked_ride_offer"),
  };
}

export function resolveCustomerAdminEventKeyFromPushType(type: string): string | null {
  const mapped = CUSTOMER_PUSH_ALIASES[type.trim()];
  if (mapped && CUSTOMER_OS_PUSH_BY_ADMIN.has(mapped)) return mapped;
  const lower = type.trim().toLowerCase();
  if (CUSTOMER_OS_PUSH_BY_ADMIN.has(lower)) return lower;
  return null;
}

export function resolveCustomerOsPush(eventKey: string): ResolveOsPushResult {
  const admin = resolveCustomerAdminEventKeyFromPushType(eventKey);
  if (!admin) {
    return { ok: false, code: "UNKNOWN_EVENT", eventKey };
  }
  const entry = CUSTOMER_OS_PUSH_BY_ADMIN.get(admin);
  if (!entry) {
    return { ok: false, code: "UNSUPPORTED_APP_EVENT", eventKey };
  }
  return {
    ok: true,
    contract: {
      appRole: "customer",
      adminEventKey: entry.adminEventKey,
      canonicalKey: entry.canonicalKey,
      channelId: entry.channelId,
      sound: entry.sound,
      category: entry.category,
      interruptionLevel: entry.interruptionLevel,
      deepLink: entry.deepLink,
    },
  };
}

/** @deprecated Prefer resolveCustomerOsPush — kept for call-site clarity. */
export function customerAndroidChannelIdForEvent(eventKey: string): string | null {
  const resolved = resolveCustomerOsPush(eventKey);
  return resolved.ok ? resolved.contract.channelId : null;
}

/** @deprecated Prefer resolveCustomerOsPush. */
export function customerIosSoundFileNameForEvent(eventKey: string): string | null {
  const resolved = resolveCustomerOsPush(eventKey);
  return resolved.ok ? resolved.contract.sound : null;
}

export function driverNewRideOfferOsPushSound(): OsPushSoundFields {
  const c = driverRideOfferContract("new_ride_offer");
  return {
    channelId: c.channelId,
    sound: c.sound,
    category: c.category,
    interruptionLevel: c.interruptionLevel,
    deepLink: c.deepLink,
    adminEventKey: c.adminEventKey,
    canonicalKey: c.canonicalKey,
  };
}

/**
 * Resolve Customer lifecycle OS sound/channel. Unknown keys fail safely (null).
 * Never invents obsolete per-event channel IDs.
 */
export function customerLifecycleOsPushSound(eventKey: string): OsPushSoundFields | null {
  const resolved = resolveCustomerOsPush(eventKey);
  if (!resolved.ok) return null;
  const c = resolved.contract;
  return {
    channelId: c.channelId,
    sound: c.sound,
    category: c.category,
    interruptionLevel: c.interruptionLevel,
    deepLink: c.deepLink,
    adminEventKey: c.adminEventKey,
    canonicalKey: c.canonicalKey,
  };
}

export function listCustomerOsPushContracts(): readonly OsPushContract[] {
  return Array.from(CUSTOMER_OS_PUSH_BY_ADMIN.values()).map((entry) => ({
    appRole: "customer" as const,
    adminEventKey: entry.adminEventKey,
    canonicalKey: entry.canonicalKey,
    channelId: entry.channelId,
    sound: entry.sound,
    category: entry.category,
    interruptionLevel: entry.interruptionLevel,
    deepLink: entry.deepLink,
  }));
}

/**
 * Stable event identity for retries — never random per attempt.
 * Prefer caller-supplied authoritative IDs; otherwise derive from entity keys.
 */
export function buildStableAlertIdentity(args: {
  appRole: OsPushAppRole;
  adminEventKey: string;
  eventId?: string | null;
  offerId?: string | null;
  tripId?: string | null;
  messageId?: string | null;
  notificationId?: string | null;
  stateVersion?: string | number | null;
}): { event_id: string; dedupe_key: string; event_type: string } {
  const eventType = args.adminEventKey;
  let eventId = (args.eventId ?? "").trim();
  if (!eventId && args.offerId) eventId = String(args.offerId).trim();
  if (!eventId && args.messageId) eventId = String(args.messageId).trim();
  if (!eventId && args.notificationId) eventId = String(args.notificationId).trim();
  if (!eventId && args.tripId) {
    const ver =
      args.stateVersion != null && String(args.stateVersion).length > 0
        ? `:v:${args.stateVersion}`
        : "";
    eventId = `${args.tripId}:${eventType}${ver}`;
  }
  if (!eventId) {
    // Deterministic last resort — not Date.now()/random; empty entity stays empty-scoped.
    eventId = `${args.appRole}:${eventType}:singleton`;
  }

  let dedupeKey: string;
  if (args.eventId?.trim()) {
    dedupeKey = `${args.appRole}:${eventType}:eid:${args.eventId.trim()}`;
  } else if (args.offerId?.trim()) {
    dedupeKey = `${args.appRole}:${eventType}:offer:${args.offerId.trim()}`;
  } else if (args.messageId?.trim()) {
    dedupeKey = `${args.appRole}:${eventType}:msg:${args.messageId.trim()}`;
  } else if (args.tripId?.trim()) {
    const ver =
      args.stateVersion != null && String(args.stateVersion).length > 0
        ? `:v:${args.stateVersion}`
        : "";
    dedupeKey = `${args.appRole}:${eventType}:trip:${args.tripId.trim()}${ver}`;
  } else if (args.notificationId?.trim()) {
    dedupeKey = `${args.appRole}:${eventType}:nid:${args.notificationId.trim()}`;
  } else {
    dedupeKey = `${args.appRole}:${eventType}:eid:${eventId}`;
  }

  return { event_id: eventId, dedupe_key: dedupeKey, event_type: eventType };
}

/**
 * Force allowlisted channel/sound onto a contract; reject remote/path/CAF/obsolete.
 * Returns the contract filenames — never caller-supplied unsafe values.
 */
export function enforceAllowlistedOsSoundFields(
  contract: OsPushContract,
  requested?: { channelId?: string | null; sound?: string | null },
): {
  channelId: string;
  sound: string;
  rejectedRequestedSound: boolean;
  rejectedRequestedChannel: boolean;
} {
  const reqSound = requested?.sound?.trim() || "";
  const reqChannel = requested?.channelId?.trim() || "";
  const rejectedSound =
    Boolean(reqSound) &&
    (reqSound !== contract.sound ||
      isRemoteOrPathSound(reqSound) ||
      reqSound === "ride_offer_alert.caf");
  const rejectedChannel =
    Boolean(reqChannel) &&
    (reqChannel !== contract.channelId || isObsoleteCustomerChannelId(reqChannel));
  return {
    channelId: contract.channelId,
    sound: contract.sound,
    rejectedRequestedSound: rejectedSound,
    rejectedRequestedChannel: rejectedChannel,
  };
}

/** Build FCM android + APNs blocks that reference installed SSOT assets. */
export function buildFcmOsAlertBlocks(args: {
  platform: "android" | "ios" | string;
  title: string;
  body: string;
  channelId: string;
  sound: string;
  threadId?: string;
  category?: string;
  priority?: "HIGH" | "NORMAL";
  interruptionLevel?: OsInterruptionLevel;
}): { android?: Record<string, unknown>; apns?: Record<string, unknown> } {
  // Never put URLs/paths into platform sound fields.
  const sound = isRemoteOrPathSound(args.sound) ? undefined : args.sound;

  if (args.platform === "android") {
    return {
      android: {
        priority: args.priority ?? "HIGH",
        notification: {
          channel_id: args.channelId,
          ...(sound ? { sound } : {}),
          title: args.title,
          body: args.body,
        },
      },
    };
  }
  if (args.platform === "ios") {
    const aps: Record<string, unknown> = {
      alert: { title: args.title, body: args.body },
      ...(sound ? { sound } : {}),
      ...(args.category ? { category: args.category } : {}),
      ...(args.threadId ? { "thread-id": args.threadId } : {}),
    };
    // Time Sensitive only when justified — never Critical for ordinary alerts.
    if (args.interruptionLevel === "time-sensitive") {
      aps["interruption-level"] = "time-sensitive";
    }
    return {
      apns: {
        headers: {
          "apns-priority": args.priority === "NORMAL" ? "5" : "10",
          "apns-push-type": "alert",
        },
        payload: { aps },
      },
    };
  }
  return {};
}
