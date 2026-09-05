/**
 * Lock: live Edge (admin-new) location search min length = 2 SSOT.
 * Stale rollout rows must not reintroduce the client↔Edge "mk" mismatch.
 */

import fs from 'fs';
import path from 'path';

import { LOCATION_SEARCH_MIN_QUERY_LENGTH } from '../../shared/onecabLocationSearchSSOT';

const ROOT = path.join(__dirname, '../..');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('admin-new location search min-query SSOT', () => {
  it('shared SSOT constant is 2', () => {
    expect(LOCATION_SEARCH_MIN_QUERY_LENGTH).toBe(2);
  });

  it('Edge uses LOCATION_SEARCH_MIN_QUERY_LENGTH (not stale rollout 3)', () => {
    const edge = readSrc('supabase/functions/search-onecab-locations/index.ts');
    const shared = readSrc('supabase/functions/_shared/onecabLocationSearchSSOT.ts');
    expect(shared).toMatch(/LOCATION_SEARCH_MIN_QUERY_LENGTH\s*=\s*2/);
    expect(edge).toContain('LOCATION_SEARCH_MIN_QUERY_LENGTH');
    expect(edge).toContain('reason: "query_too_short"');
    // Must not prefer rollout.min_query_length over SSOT (that re-broke "mk").
    expect(edge).not.toContain('rollout?.min_query_length ?? LOCATION_SEARCH_MIN_QUERY_LENGTH');
    expect(edge).toContain('const minLength = LOCATION_SEARCH_MIN_QUERY_LENGTH');
  });

  it('migration forces rollout min_query_length = 2', () => {
    const migration = readSrc(
      'supabase/migrations/20261106210000_location_search_min_query_length_2.sql',
    );
    expect(migration).toContain('min_query_length = 2');
    expect(migration).toContain('SET DEFAULT 2');
  });

  it('Places API New remains the live provider (no address-only types)', () => {
    const edge = readSrc('supabase/functions/search-onecab-locations/index.ts');
    expect(edge).toContain('places.googleapis.com/v1/places:autocomplete');
    expect(edge).toContain('locationBias');
    expect(edge).not.toContain('includedPrimaryTypes');
    expect(edge).not.toContain('types=address');
  });
});
