#!/usr/bin/env node
/** Supplemental captures: Asiya row (page 2) + Milton Keynes region filter */
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots', 'phase4');
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:8081';
const PROJECT_REF = 'thazislrdkjpvvghtvzo';
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const ADMIN_EMAIL = 'admin@onecab.net';

function loadEnv() {
  for (const name of ['.env', '.env.local']) {
    const p = path.join(ROOT, name);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

function serviceRoleKey() {
  const raw = execSync(`supabase projects api-keys --project-ref ${PROJECT_REF} -o json`, { encoding: 'utf8', cwd: ROOT });
  const parsed = JSON.parse(raw);
  const entry = Array.isArray(parsed) ? parsed.find((k) => k.name === 'service_role') : parsed.keys?.find((k) => k.name === 'service_role');
  return entry?.api_key;
}

async function createSession() {
  const admin = createClient(SUPABASE_URL, serviceRoleKey(), { auth: { autoRefreshToken: false, persistSession: false } });
  const pub = createClient(SUPABASE_URL, process.env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: ADMIN_EMAIL });
  const { data: verified } = await pub.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'email' });
  return verified.session;
}

async function main() {
  loadEnv();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const session = await createSession();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ k, s }) => localStorage.setItem(k, JSON.stringify({
    access_token: s.access_token, refresh_token: s.refresh_token,
    expires_at: s.expires_at, expires_in: s.expires_in, token_type: s.token_type, user: s.user,
  })), { k: `sb-${PROJECT_REF}-auth-token`, s: session });

  await page.goto(`${BASE_URL}/driver-wallet-ledger`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.body.textContent?.includes('Loading SSOT…'), null, { timeout: 120_000 });

  // Region: Milton Keynes
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: /Milton Keynes/i }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT_DIR, '03-region-filter-milton-keynes.png'), fullPage: true });
  console.log('Saved 03-region-filter-milton-keynes.png');

  // Page 2 — Asiya
  await page.getByRole('button', { name: /^Next$/i }).click();
  await page.waitForTimeout(2500);
  const asiyaRow = page.getByRole('row').filter({ hasText: /asiya|wehliye/i }).first();
  await asiyaRow.scrollIntoViewIfNeeded();
  await asiyaRow.screenshot({ path: path.join(OUT_DIR, '06-driver-stripe-paid.png') });
  await page.screenshot({ path: path.join(OUT_DIR, '04-pagination-page2-asiya.png'), fullPage: true });
  console.log('Saved 06-driver-stripe-paid.png + 04-pagination-page2-asiya.png');

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
