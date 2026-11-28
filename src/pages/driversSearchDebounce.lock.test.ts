/**
 * A1 — Drivers search must debounce before server refetch.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, 'Drivers.tsx'), 'utf8');

describe('Drivers search debounce (A1)', () => {
  it('debounces searchQuery into debouncedSearchQuery before fetch', () => {
    expect(src).toContain('debouncedSearchQuery');
    expect(src).toContain('setDebouncedSearchQuery');
    expect(src).toMatch(/setTimeout\(\(\)\s*=>\s*setDebouncedSearchQuery\(searchQuery\),\s*300\)/);
    expect(src).toContain('const q = debouncedSearchQuery.trim()');
    expect(src).toContain(
      '[listPage, statusFilter, debouncedSearchQuery, selectedRegionFilter, selectedServiceAreaFilter]',
    );
  });
});
