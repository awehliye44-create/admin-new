import { supabase } from '@/integrations/supabase/client';

/**
 * Council Licence = the licensing council/authority that issued the driver's
 * private hire driver licence. Internal, admin-only. It is NOT the assigned
 * service area and is never exposed to the driver or customer apps.
 */

export const COUNCIL_LICENCE_DATALIST_ID = 'council-licence-options';

export const COUNCIL_LICENCE_SUGGESTIONS = [
  'Transport for London (TfL)',
  'Wolverhampton Council',
  'Milton Keynes Council',
  'Birmingham City Council',
  'Luton Borough Council',
  'Bedford Borough Council',
  'Central Bedfordshire Council',
  'Buckinghamshire Council',
  'Northampton (West Northamptonshire Council)',
  'Leeds City Council',
  'Manchester City Council',
  'Sefton Council',
  'Rossendale Borough Council',
  'Gateshead Council',
] as const;

export function normaliseCouncilLicence(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Admin-only read. Returns driver_id -> council licence authority. */
export async function fetchCouncilLicences(
  driverIds: string[],
): Promise<Record<string, string | null>> {
  if (driverIds.length === 0) return {};
  const { data, error } = await supabase
    .from('driver_internal_profiles')
    .select('driver_id, council_licence_authority')
    .in('driver_id', driverIds);

  if (error) throw error;

  const map: Record<string, string | null> = {};
  (data ?? []).forEach((row) => {
    map[row.driver_id] = normaliseCouncilLicence(row.council_licence_authority);
  });
  return map;
}

/** Admin-only write. Upserts the driver's internal council licence value. */
export async function saveCouncilLicence(
  driverId: string,
  value: string | null | undefined,
): Promise<string | null> {
  const normalised = normaliseCouncilLicence(value);
  const { error } = await supabase
    .from('driver_internal_profiles')
    .upsert(
      { driver_id: driverId, council_licence_authority: normalised },
      { onConflict: 'driver_id' },
    );

  if (error) throw error;
  return normalised;
}
