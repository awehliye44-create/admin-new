/**
 * A1 continued — Trip History client search debounce (typing immediate; filter lagged).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, 'TripHistory.tsx'), 'utf8');

describe('Trip History search debounce (A1 continued)', () => {
  it('debounces filter input while keeping controlled searchQuery for typing', () => {
    expect(src).toContain('debouncedSearchQuery');
    expect(src).toMatch(/setTimeout\(\(\)\s*=>\s*setDebouncedSearchQuery\(searchQuery\),\s*300\)/);
    expect(src).toContain('const q = debouncedSearchQuery.toLowerCase()');
    // Input must still bind to live searchQuery for immediate keystroke feedback
    expect(src).toMatch(/value=\{searchQuery\}/);
  });
});
