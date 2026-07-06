/** Finance era is permanently digital. */
export type FinanceEra = 'digital';

export function useFinanceEra(): {
  era: FinanceEra;
  startedAt: string | null;
  loading: boolean;
} {
  return { era: 'digital', startedAt: null, loading: false };
}
