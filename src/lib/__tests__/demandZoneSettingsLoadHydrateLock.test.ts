/**
 * Lock: Heat map & surge settings dialog must not:
 *  - Render editable defaults as a successful load
 *  - Throw on incomplete hex during render
 *  - Verify only surge_enabled after save
 *  - Allow Save while load failed / All service areas selected
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const dialogPath = join(root, 'src/components/dispatch/DemandZoneSettingsDialog.tsx');
const formPath = join(root, 'src/lib/demandZoneSettingsForm.ts');

describe('demand zone settings load/hydrate lock', () => {
  const dialog = readFileSync(dialogPath, 'utf8');
  const form = readFileSync(formPath, 'utf8');

  it('uses safe hex display instead of throwing normaliseHexColour in colour render paths', () => {
    expect(dialog).toContain('safeHexColourForDisplay');
    // Colour picker / preview must not call throwing normaliser on draft text.
    expect(dialog).not.toMatch(/value=\{normaliseHexColour\(form\[key\]/);
    expect(dialog).not.toMatch(/backgroundColor:\s*normaliseHexColour\(form\[key\]/);
  });

  it('verifies the full saved settings payload, not only surge_enabled', () => {
    expect(dialog).toContain('verifyDemandZoneSettingsSaved');
    expect(dialog).not.toMatch(
      /if\s*\(\s*!saved\s*\|\|\s*saved\.surge_enabled\s*!==\s*form\.surge_enabled\s*\)/,
    );
    expect(form).toContain('DEMAND_ZONE_SETTINGS_EDIT_KEYS');
    expect(form).toContain('colour_low');
    expect(form).toContain('zone_radius_meters');
    expect(form).toContain('multiplier_low');
  });

  it('gates Save on successful load (or explicit starter seed) and blocks All service areas', () => {
    expect(dialog).toContain("loadStatus !== 'ready'");
    expect(dialog).toContain('seededForCreate');
    expect(dialog).toContain('ALL_SERVICE_AREAS_MESSAGE');
    expect(dialog).toContain('Select one service area');
    expect(dialog).toContain('Save stays disabled until load succeeds');
  });

  it('separates error / missing / ready and exposes Retry without showing defaults as loaded', () => {
    expect(dialog).toContain("loadStatus === 'error'");
    expect(dialog).toContain("loadStatus === 'missing'");
    expect(dialog).toContain('Could not load settings');
    expect(dialog).toContain('No saved settings for');
    expect(dialog).toContain('Retry');
    expect(dialog).toContain('Prepare starter defaults');
    expect(dialog).toContain('Starter defaults are shown for first-time create only');
  });

  it('does not silently discard dirty edits on background refetch', () => {
    expect(dialog).toContain('serverSettingsAreNewerThanBaseline');
    expect(dialog).toContain('Server settings changed while you were editing');
    expect(dialog).toContain('Reload server values');
    expect(dialog).toContain('Keep editing');
    expect(form).toContain('shouldRehydrateDemandZoneSettingsForm');
  });

  it('clears hydration when the selected service area changes', () => {
    expect(dialog).toContain('hydratedServiceAreaId !== serviceAreaId');
    expect(dialog).toContain('setHydratedServiceAreaId(null)');
  });
});
