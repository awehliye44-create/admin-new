/**
 * Bounded parallel map — preserves input order in results.
 * Used by expire-offers rebroadcast so many searching trips do not await serially.
 */

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  if (n === 0) return [];

  const limit = Math.max(1, Math.min(n, Math.floor(concurrency) || 1));
  const results = new Array<R>(n);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= n) return;
      results[i] = await worker(items[i] as T, i);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}
