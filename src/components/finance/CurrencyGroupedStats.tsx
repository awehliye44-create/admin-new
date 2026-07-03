import { formatMoneyMinor, getCurrencyMinorUnit } from '@/lib/formatMoneyMinor';

interface CurrencyTotal {
  currencyCode: string;
  total: number;
}

interface CurrencyGroupedStatsProps {
  /** Items with currency_code and an amount field */
  items: { currency_code: string; amount: number }[];
  label?: string;
  className?: string;
}

/**
 * When "All Services" is selected and multiple currencies exist,
 * this component shows grouped totals per currency instead of one merged number.
 */
export function CurrencyGroupedStats({ items, label, className }: CurrencyGroupedStatsProps) {
  const grouped = items.reduce<Record<string, number>>((acc, item) => {
    const cc = item.currency_code || '???';
    acc[cc] = (acc[cc] || 0) + item.amount;
    return acc;
  }, {});

  const entries = Object.entries(grouped);

  if (entries.length === 0) {
    return <span className={className}>—</span>;
  }

  // Single currency — show simple value
  if (entries.length === 1) {
    const [cc, total] = entries[0];
    return <span className={className}>{formatMoneyMinor(total, cc, 'en-GB', getCurrencyMinorUnit(cc))}</span>;
  }

  // Multiple currencies — show each on its own line
  return (
    <div className={className}>
      {label && <p className="text-xs text-muted-foreground mb-1">{label}</p>}
      {entries.map(([cc, total]) => (
        <div key={cc} className="flex items-center gap-1">
          <span className="text-xs font-medium text-muted-foreground">{cc}</span>
          <span>{formatMoneyMinor(total, cc, 'en-GB', getCurrencyMinorUnit(cc))}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Helper: check if a list of drivers has mixed currencies.
 */
export function hasMixedCurrencies(items: { currency_code: string }[]): boolean {
  if (items.length === 0) return false;
  const first = items[0].currency_code;
  return items.some(i => i.currency_code !== first);
}

/**
 * Helper: get the single currency from a list, or null if mixed.
 */
export function getSingleCurrency(items: { currency_code: string }[]): string | null {
  if (items.length === 0) return null;
  const first = items[0].currency_code;
  if (items.every(i => i.currency_code === first)) return first;
  return null;
}
