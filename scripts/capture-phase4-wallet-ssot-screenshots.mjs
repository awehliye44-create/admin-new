#!/usr/bin/env node
/**
 * Capture authenticated Phase 4 screenshots (local admin + prod edge).
 * Requires: supabase CLI logged in, npm run dev on :8080 (or PLAYWRIGHT_SKIP_WEBSERVER).
 *
 * Usage: node scripts/capture-phase4-wallet-ssot-screenshots.mjs
 */
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots', 'phase4');
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:8080';
const PROJECT_REF = process.env.VITE_SUPABASE_PROJECT_ID ?? 'thazislrdkjpvvghtvzo';
const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? `https://${PROJECT_REF}.supabase.co`;
const ADMIN_EMAIL = process.env.PLAYWRIGHT_ADMIN_EMAIL ?? 'admin@onecab.net';

function loadEnvFile(name) {
  const p = path.join(ROOT, name);
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function serviceRoleKey() {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  const raw = execSync(`supabase projects api-keys --project-ref ${PROJECT_REF} -o json`, {
    encoding: 'utf8',
    cwd: ROOT,
  });
  const parsed = JSON.parse(raw);
  const entry = Array.isArray(parsed)
    ? parsed.find((k) => k.name === 'service_role' || k.id === 'service_role')
    : parsed.keys?.find((k) => k.name === 'service_role');
  const key = entry?.api_key;
  if (!key) throw new Error('Could not resolve service_role API key');
  return key;
}

async function createAdminSession() {
  const serviceKey = serviceRoleKey();
  const adminClient = createClient(SUPABASE_URL, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const anonKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!anonKey) throw new Error('VITE_SUPABASE_PUBLISHABLE_KEY missing — load .env');
  const publicClient = createClient(SUPABASE_URL, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: linkData, error: linkErr } = await adminClient.auth.admin.generateLink({
    type: 'magiclink',
    email: ADMIN_EMAIL,
  });
  if (linkErr) throw linkErr;
  const tokenHash = linkData?.properties?.hashed_token;
  if (!tokenHash) throw new Error('No hashed_token from generateLink');

  const { data: verified, error: verifyErr } = await publicClient.auth.verifyOtp({
    token_hash: tokenHash,
    type: 'email',
  });
  if (verifyErr) throw verifyErr;
  if (!verified.session) throw new Error('No session after verifyOtp');
  return verified.session;
}

async function injectSession(page, session) {
  const storageKey = `sb-${PROJECT_REF}-auth-token`;
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ storageKey, session }) => {
    localStorage.setItem(storageKey, JSON.stringify({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
      expires_in: session.expires_in,
      token_type: session.token_type,
      user: session.user,
    }));
  }, { storageKey, session });
}

async function waitForSsotTable(page) {
  await page.goto(`${BASE_URL}/driver-wallet-ledger`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /Driver Wallet Ledger \(SSOT\)/i }).first().waitFor({ timeout: 60_000 });
  await page.getByText('Driver Wallet Ledger (SSOT)', { exact: false }).first().waitFor();
  // Wait for loading to finish
  await page.waitForFunction(() => !document.body.textContent?.includes('Loading SSOT…'), null, { timeout: 120_000 });
  await page.waitForTimeout(1500);
}

async function main() {
  loadEnvFile('.env');
  loadEnvFile('.env.local');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  console.log('Authenticating admin session via service role…');
  const session = await createAdminSession();
  await injectSession(page, session);
  await page.goto(`${BASE_URL}/driver-wallet-ledger`, { waitUntil: 'networkidle' });

  await waitForSsotTable(page);
  await page.screenshot({ path: path.join(OUT_DIR, '01-main-table.png'), fullPage: true });
  console.log('Saved 01-main-table.png');

  // LOCAL_ONLY driver (Ahmed MK0001)
  const ahmedRow = page.getByRole('row').filter({ hasText: /MK0001|Ahmed Osman/i }).first();
  if (await ahmedRow.count()) {
    await ahmedRow.scrollIntoViewIfNeeded();
    await ahmedRow.screenshot({ path: path.join(OUT_DIR, '05-driver-local-only-failed.png') });
    console.log('Saved 05-driver-local-only-failed.png');
  }

  // Stripe paid driver (Asiya)
  const asiyaRow = page.getByRole('row').filter({ hasText: /asiya|MK0002/i }).first();
  if (await asiyaRow.count()) {
    await asiyaRow.scrollIntoViewIfNeeded();
    await asiyaRow.screenshot({ path: path.join(OUT_DIR, '06-driver-stripe-paid.png') });
    console.log('Saved 06-driver-stripe-paid.png');
  }

  // Three-dot detail drawer — prefer Ahmed (LOCAL_ONLY)
  const detailRow = (await ahmedRow.count()) ? ahmedRow : page.getByRole('row').nth(1);
  await detailRow.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: /Payout & ledger details/i }).click();
  await page.getByRole('dialog').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT_DIR, '02-detail-drawer.png'), fullPage: true });
  console.log('Saved 02-detail-drawer.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // Region filter — service area select
  const regionTrigger = page.locator('button').filter({ has: page.locator('svg') }).filter({ hasText: /All Services|Loading/i }).first();
  if (await regionTrigger.count()) {
    await regionTrigger.click();
    const option = page.getByRole('option').nth(1);
    if (await option.count()) {
      const label = await option.textContent();
      await option.click();
      await waitForSsotTable(page);
      await page.screenshot({ path: path.join(OUT_DIR, '03-region-filter.png'), fullPage: true });
      console.log(`Saved 03-region-filter.png (${label?.trim()})`);
    }
  } else {
    // Fallback: screenshot filter bar present
    await page.screenshot({ path: path.join(OUT_DIR, '03-region-filter.png'), fullPage: true });
    console.log('Saved 03-region-filter.png (filter bar)');
  }

  // Pagination — go to page 2 if available
  const nextBtn = page.getByRole('button', { name: /^Next$/i });
  if (await nextBtn.isEnabled()) {
    await nextBtn.click();
    await waitForSsotTable(page);
    await page.screenshot({ path: path.join(OUT_DIR, '04-pagination-page2.png'), fullPage: true });
    console.log('Saved 04-pagination-page2.png');
  } else {
    await page.screenshot({ path: path.join(OUT_DIR, '04-pagination-single-page.png'), fullPage: true });
    console.log('Saved 04-pagination-single-page.png (total <= page size)');
  }

  await browser.close();
  console.log(`\nScreenshots written to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
