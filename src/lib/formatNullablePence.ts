import { formatMoneyMinor } from '@/lib/formatMoneyMinor';

/** Display backend minor units; never invent £0 for NULL. */
export function formatNullablePence(
  pence: number | null | undefined,
  currency = 'GBP',
  nullLabel = '—',
): string {
  if (pence == null) return nullLabel;
  return formatMoneyMinor(pence, currency, 'en-GB', 2);
}

export function formatAgeMinutes(minutes: number): string {
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rem = Math.round(minutes % 60);
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}
