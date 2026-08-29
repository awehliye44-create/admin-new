/**
 * Lock: Admin Sentry must not send default PII or hardcode a DSN.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');

describe('adminSentryPrivacyLock', () => {
  it('initialises from VITE_SENTRY_DSN with sendDefaultPii false', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/lib/sentry.ts'), 'utf8');
    expect(src).toContain('VITE_SENTRY_DSN');
    expect(src).toContain('sendDefaultPii: false');
    expect(src).toContain('beforeSend');
    expect(src).not.toContain('sendDefaultPii: true');
    expect(src).not.toMatch(/dsn:\s*["']https:\/\//);
    expect(src).toMatch(/setUser\(\{\s*id:\s*user\.id/);
    expect(src).not.toMatch(/setUser\(\{[\s\S]*email:\s*user\.email/);
  });
});
