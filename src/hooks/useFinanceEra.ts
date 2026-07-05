/** Finance era is permanently digital — legacy cash workflows are retired. */
export type FinanceEra = 'digital';

export function useFinanceEra(): {
  era: FinanceEra;
  startedAt: string | null;
  loading: boolean;
} {
  return { era: 'digital', startedAt: null, loading: false };
}
