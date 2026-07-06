export type TripAuditStatusTone = 'green' | 'yellow' | 'blue' | 'orange' | 'gray' | 'red';

export interface TripAuditStatusBadge {
  label: string;
  tone: TripAuditStatusTone;
}

const toneClassMap: Record<TripAuditStatusTone, string> = {
  green: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  yellow: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200',
  blue: 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200',
  orange: 'border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-200',
  gray: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300',
  red: 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200',
};

const VALID_TONES = new Set<string>(Object.keys(toneClassMap));

function toneFromLabel(label: string): TripAuditStatusTone {
  const l = label.toLowerCase();
  if (l.includes('paid out') || l.includes('already collected') || l.includes('earned') || l.includes('settled')) {
    return 'green';
  }
  if (l.includes('awaiting payout') || l.includes('pending capture')) return 'yellow';
  if (l.includes('captured')) return 'blue';
  if (l.includes('historical legacy')) return 'gray';
  if (l.includes('reversed') || l.includes('refunded') || l.includes('failed')) return 'red';
  if (l.includes('receivable') || l.includes('on hold') || l.includes('under review') || l.includes('disputed')) {
    return 'orange';
  }
  return 'yellow';
}

/** Coerce API badge objects, legacy string statuses, or missing values into a safe badge. */
export function normalizeTripAuditStatusBadge(
  value: unknown,
  legacyLabel?: string | null,
): TripAuditStatusBadge {
  if (value && typeof value === 'object' && 'label' in value) {
    const badge = value as TripAuditStatusBadge;
    const label = String(badge.label ?? legacyLabel ?? 'Unknown');
    const tone = VALID_TONES.has(String(badge.tone)) ? (badge.tone as TripAuditStatusTone) : toneFromLabel(label);
    return { label, tone };
  }

  const label = String(
    (typeof value === 'string' ? value : null)
    ?? legacyLabel
    ?? 'Unknown',
  );
  return { label, tone: toneFromLabel(label) };
}

export function tripAuditStatusBadgeClassName(tone: TripAuditStatusTone): string {
  return toneClassMap[tone] ?? toneClassMap.yellow;
}
