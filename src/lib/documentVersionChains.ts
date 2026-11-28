/**
 * Group Admin document rows into version chains by driver + type + vehicle.
 * Current vs retired (superseded / is_current=false) stay visible; never deletes history.
 */

export type DocumentVersionRow = {
  id: string;
  driver_id: string;
  document_type: string;
  document_name: string;
  status: string;
  expiry_date: string | null;
  notes: string | null;
  rejection_reason: string | null;
  reviewed_at: string | null;
  reviewerId?: string | null;
  created_at: string;
  is_current: boolean;
  superseded_by: string | null;
  vehicle_id: string | null;
  ambiguity_review_required?: boolean | null;
  file_url?: string | null;
  driver?: {
    id: string;
    first_name: string;
    last_name: string;
    phone: string;
    deleted_at: string | null;
  } | null;
  vehicle?: {
    id: string;
    make: string | null;
    model: string | null;
    year: number | null;
    license_plate: string | null;
    is_primary: boolean | null;
    is_trip_active: boolean | null;
    operational_status: string | null;
  } | null;
};

export type DocumentVersionChain = {
  key: string;
  driverId: string;
  documentType: string;
  vehicleId: string | null;
  driver: DocumentVersionRow['driver'];
  vehicle: DocumentVersionRow['vehicle'];
  /** Newest first within the chain. */
  versions: DocumentVersionRow[];
  current: DocumentVersionRow | null;
};

export function documentVersionChainKey(
  driverId: string,
  documentType: string,
  vehicleId: string | null | undefined,
): string {
  return `${driverId}::${documentType}::${vehicleId ?? 'driver'}`;
}

export function groupDocumentsIntoVersionChains(
  docs: DocumentVersionRow[],
): DocumentVersionChain[] {
  const buckets = new Map<string, DocumentVersionRow[]>();
  for (const doc of docs) {
    const key = documentVersionChainKey(doc.driver_id, doc.document_type, doc.vehicle_id);
    const list = buckets.get(key);
    if (list) list.push(doc);
    else buckets.set(key, [doc]);
  }

  const chains: DocumentVersionChain[] = [];
  for (const [key, versions] of buckets) {
    const sorted = [...versions].sort((a, b) => {
      const ta = new Date(a.created_at).getTime();
      const tb = new Date(b.created_at).getTime();
      if (tb !== ta) return tb - ta;
      return a.id.localeCompare(b.id);
    });
    const current =
      sorted.find((v) => v.is_current !== false && !v.superseded_by) ??
      sorted.find((v) => v.is_current !== false) ??
      null;
    const first = sorted[0];
    chains.push({
      key,
      driverId: first.driver_id,
      documentType: first.document_type,
      vehicleId: first.vehicle_id,
      driver: first.driver ?? null,
      vehicle: first.vehicle ?? null,
      versions: sorted,
      current,
    });
  }

  // Chains with pending / action-needed first, then by driver name + type.
  chains.sort((a, b) => {
    const rank = (c: DocumentVersionChain) => {
      const s = c.current?.status ?? c.versions[0]?.status ?? '';
      if (s === 'pending') return 0;
      if (s === 'rejected') return 1;
      if (s === 'expired') return 2;
      return 3;
    };
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    const nameA = `${a.driver?.last_name ?? ''} ${a.driver?.first_name ?? ''}`.trim();
    const nameB = `${b.driver?.last_name ?? ''} ${b.driver?.first_name ?? ''}`.trim();
    if (nameA !== nameB) return nameA.localeCompare(nameB);
    if (a.documentType !== b.documentType) return a.documentType.localeCompare(b.documentType);
    return (a.vehicleId ?? '').localeCompare(b.vehicleId ?? '');
  });

  return chains;
}

export function versionLifecycleLabel(doc: DocumentVersionRow): 'Current' | 'Retired' {
  if (doc.is_current === false || Boolean(doc.superseded_by)) return 'Retired';
  return 'Current';
}
