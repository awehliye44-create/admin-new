/**
 * Canonical preset fare chips â Admin Preset Fare Offers (preset_offers) only.
 * Written to ride_offers.offer_snapshot.preset_options at dispatch; read by driver + customer apps.
 */

export type PresetOptionCanonical = {
  key: string;
  label: string | null;
  grossFare: number;
  grossFarePence: number;
  /** Driver-visible net (when stamped server-side). */
  driverNetPence?: number;
  driver_net_pence?: number;
  configuredAmount: number | null;
  color: string | null;
  order: number;
  enabled: boolean;
};

export type AdminPresetOfferRow = {
  offer_key?: string | null;
  label?: string | null;
  fixed_amount_pence?: number | null;
  multiplier?: number | null;
  color?: string | null;
  display_order?: number | null;
  is_active?: boolean | null;
};

export function computePresetOfferFarePence(
  baseFarePence: number,
  offer: { fixed_amount_pence: number | null; multiplier: number | null },
  priceMode: string,
): number | null {
  if (priceMode === "fixed_amount" && offer.fixed_amount_pence != null) {
    return baseFarePence + offer.fixed_amount_pence;
  }
  if (priceMode === "fixed" && offer.fixed_amount_pence != null) {
    if (offer.fixed_amount_pence < baseFarePence) {
      return baseFarePence + offer.fixed_amount_pence;
    }
    return offer.fixed_amount_pence;
  }
  if (
    (priceMode === "multiplier" || priceMode === "percentage" || priceMode === "percent") &&
    offer.multiplier != null
  ) {
    return Math.round(baseFarePence * offer.multiplier);
  }
  if (offer.fixed_amount_pence != null) return baseFarePence + offer.fixed_amount_pence;
  return null;
}

function configuredAmountFromRow(
  offer: AdminPresetOfferRow,
  priceMode: string,
): number | null {
  if (offer.fixed_amount_pence != null) {
    return offer.fixed_amount_pence / 100;
  }
  if (
    (priceMode === "multiplier" || priceMode === "percentage" || priceMode === "percent") &&
    offer.multiplier != null
  ) {
    return offer.multiplier;
  }
  return null;
}

/** Build up to 3 unique preset_options from admin preset_offers rows. */
export function buildPresetOptionsFromAdminOffers(
  baseFarePence: number,
  offers: AdminPresetOfferRow[],
  priceMode: string,
): PresetOptionCanonical[] {
  if (baseFarePence <= 0) return [];

  const normalizedMode = priceMode === "fixed" ? "fixed_amount" : priceMode;
  const active = offers
    .filter((o) => o.is_active !== false)
    .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));

  const result: PresetOptionCanonical[] = [];
  const seenPence = new Set<number>();

  for (let i = 0; i < active.length; i++) {
    const row = active[i];
    const pence = computePresetOfferFarePence(
      baseFarePence,
      {
        fixed_amount_pence: row.fixed_amount_pence ?? null,
        multiplier: row.multiplier ?? null,
      },
      normalizedMode,
    );
    if (pence == null || pence <= 0 || seenPence.has(pence)) continue;
    seenPence.add(pence);

    const key =
      typeof row.offer_key === "string" && row.offer_key.trim().length > 0
        ? row.offer_key.trim()
        : `P${result.length + 1}`;

    result.push({
      key,
      label: row.label ?? null,
      grossFare: Math.round((pence / 100) * 100) / 100,
      grossFarePence: pence,
      configuredAmount: configuredAmountFromRow(row, normalizedMode),
      color: row.color ?? null,
      order: row.display_order ?? i,
      enabled: true,
    });

    if (result.length >= 3) break;
  }

  return result.sort((a, b) => a.order - b.order);
}

export function deriveOfferOptionsPence(options: PresetOptionCanonical[]): number[] {
  return options.map((o) => o.grossFarePence);
}

export function parseOfferSnapshot(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function penceFromRawOption(o: Record<string, unknown>): number | null {
  if (o.grossFarePence != null && Number.isFinite(Number(o.grossFarePence))) {
    return Math.round(Number(o.grossFarePence));
  }
  if (o.grossFare != null && Number.isFinite(Number(o.grossFare))) {
    return Math.round(Number(o.grossFare) * 100);
  }
  return null;
}

function configuredAmountPenceFromRaw(o: Record<string, unknown>): number | null {
  if (o.configuredAmountPence != null && Number.isFinite(Number(o.configuredAmountPence))) {
    return Math.round(Number(o.configuredAmountPence));
  }
  if (o.configuredAmount != null && Number.isFinite(Number(o.configuredAmount))) {
    return Math.round(Number(o.configuredAmount) * 100);
  }
  return null;
}

/** Minimum unique presets required before chips / negotiation UI. */
export const MIN_PRESET_OPTIONS = 3;

function mapRawPresetOptionRows(raw: unknown[]): PresetOptionCanonical[] {
  const mapped: PresetOptionCanonical[] = [];
  const seenPence = new Set<number>();

  for (let i = 0; i < raw.length; i++) {
    const o = raw[i];
    if (!o || typeof o !== "object") continue;
    const row = o as Record<string, unknown>;
    const pence = penceFromRawOption(row);
    if (pence == null || pence <= 0 || seenPence.has(pence)) continue;
    seenPence.add(pence);

    const key =
      typeof row.key === "string" && row.key.trim().length > 0
        ? row.key.trim()
        : `P${mapped.length + 1}`;

    const configuredPence = configuredAmountPenceFromRaw(row);
    const configuredAmount =
      row.configuredAmount != null && Number.isFinite(Number(row.configuredAmount))
        ? Number(row.configuredAmount)
        : configuredPence != null
        ? configuredPence / 100
        : null;

    mapped.push({
      key,
      label: (row.label as string) ?? null,
      grossFare:
        row.grossFare != null && Number.isFinite(Number(row.grossFare))
          ? Number(row.grossFare)
          : pence / 100,
      grossFarePence: pence,
      configuredAmount,
      color: (row.color as string) ?? null,
      order: (row.order as number) ?? (row.display_order as number) ?? i,
      enabled: row.enabled !== false,
      ...(Number(row.driverNetPence ?? row.driver_net_pence) > 0
        ? {
          driverNetPence: Math.round(Number(row.driverNetPence ?? row.driver_net_pence)),
          driver_net_pence: Math.round(Number(row.driverNetPence ?? row.driver_net_pence)),
        }
        : {}),
    } as PresetOptionCanonical);
  }

  return mapped
    .filter((o) => o.enabled)
    .sort((a, b) => a.order - b.order)
    .slice(0, 3);
}

/** Normalize snapshot / row preset_options (SSOT for UI). */
export function extractPresetOptionsFromSnapshot(
  snapshot: unknown,
): PresetOptionCanonical[] {
  const snap = parseOfferSnapshot(snapshot);
  const raw = snap?.preset_options;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return mapRawPresetOptionRows(raw);
}

function extractLegacyPresetFareOffersFromSnapshot(
  snapshot: Record<string, unknown>,
): PresetOptionCanonical[] {
  const legacy = snapshot.presetFareOffers;
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) return [];
  const options = (legacy as { options?: unknown }).options;
  if (!Array.isArray(options) || options.length === 0) return [];
  return mapRawPresetOptionRows(options);
}

function extractFromOfferOptionsPence(penceList: number[]): PresetOptionCanonical[] {
  const unique: number[] = [];
  const seen = new Set<number>();
  for (const raw of penceList) {
    const pence = Math.round(Number(raw));
    if (!Number.isFinite(pence) || pence <= 0 || seen.has(pence)) continue;
    seen.add(pence);
    unique.push(pence);
  }
  if (unique.length < MIN_PRESET_OPTIONS) return [];
  return unique.slice(0, MIN_PRESET_OPTIONS).map((pence, i) => ({
    key: `P${i + 1}`,
    label: null,
    grossFare: pence / 100,
    grossFarePence: pence,
    configuredAmount: null,
    color: null,
    order: i,
    enabled: true,
  }));
}

/**
 * Read preset chips from ride offer row.
 * Primary: offer_snapshot.preset_options â legacy presetFareOffers.options â offer_options.
 */
export function extractPresetOptionsFromOffer(row: {
  offer_snapshot?: unknown;
  offer_options?: number[] | null;
} | null | undefined): PresetOptionCanonical[] {
  if (!row) return [];

  const fromSnapshot = extractPresetOptionsFromSnapshot(row.offer_snapshot);
  if (fromSnapshot.length >= MIN_PRESET_OPTIONS) return fromSnapshot;

  const snap = parseOfferSnapshot(row.offer_snapshot);
  if (snap) {
    const fromLegacy = extractLegacyPresetFareOffersFromSnapshot(snap);
    if (fromLegacy.length >= MIN_PRESET_OPTIONS) return fromLegacy;
  }

  if (Array.isArray(row.offer_options)) {
    const fromOptions = extractFromOfferOptionsPence(row.offer_options);
    if (fromOptions.length >= MIN_PRESET_OPTIONS) return fromOptions;
  }

  return [];
}

export function faresMatchPence(a: number, b: number): boolean {
  return a === b || Math.abs(a - b) <= 2;
}

export function buildNegotiationFromPresetOptions(
  presetOptions: PresetOptionCanonical[],
  selectedFarePence: number,
  selectedOfferKey?: string | null,
): {
  selectedOffer: PresetOptionCanonical;
  remainingOptions: PresetOptionCanonical[];
} {
  const selected =
    presetOptions.find((o) =>
      selectedOfferKey && o.key === selectedOfferKey
    )
    ?? presetOptions.find((o) => faresMatchPence(o.grossFarePence, selectedFarePence))
    ?? presetOptions[0];

  if (!selected) {
    const fallback: PresetOptionCanonical = {
      key: selectedOfferKey ?? "selected",
      label: null,
      grossFare: selectedFarePence / 100,
      grossFarePence: selectedFarePence,
      configuredAmount: null,
      color: null,
      order: 0,
      enabled: true,
    };
    return { selectedOffer: fallback, remainingOptions: [] };
  }

  const remainingOptions = presetOptions.filter(
    (o) => o.key !== selected.key && !faresMatchPence(o.grossFarePence, selected.grossFarePence),
  );

  return { selectedOffer: selected, remainingOptions };
}

export type DriverPresetChipOption = {
  key: string;
  /** Negotiation wire format â not shown to drivers. */
  grossFarePence: number;
  /** Driver-visible chip amount (net earnings). */
  driverNetPence: number;
  label?: string | null;
  color?: string | null;
  order?: number;
  configuredAmountPence?: number | null;
};

export type CustomerPresetFareOption = {
  key: string;
  grossFarePence: number;
  grossFare?: number;
  label?: string | null;
  color?: string | null;
  order?: number;
  configuredAmountPence?: number | null;
};

export function toDriverPresetChipOption(o: PresetOptionCanonical): DriverPresetChipOption {
  const driverNet =
    (o as PresetOptionCanonical & { driverNetPence?: number }).driverNetPence
    ?? (o as PresetOptionCanonical & { driver_net_pence?: number }).driver_net_pence
    ?? 0;
  return {
    key: o.key,
    grossFarePence: o.grossFarePence,
    driverNetPence: driverNet > 0 ? driverNet : 0,
    label: o.label,
    color: o.color,
    order: o.order,
    configuredAmountPence:
      o.configuredAmount != null ? Math.round(o.configuredAmount * 100) : null,
  };
}

export function toCustomerPresetFareOption(o: PresetOptionCanonical): CustomerPresetFareOption {
  return {
    key: o.key,
    grossFarePence: o.grossFarePence,
    grossFare: o.grossFare,
    label: o.label,
    color: o.color,
    order: o.order,
    configuredAmountPence:
      o.configuredAmount != null ? Math.round(o.configuredAmount * 100) : null,
  };
}
