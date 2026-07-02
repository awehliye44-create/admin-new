#!/usr/bin/env node
/**
 * Production screenshots — adminonecab.net after GitHub Pages deploy.
 * Usage: node scripts/capture-production-ssot-screenshots.mjs
 */
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots', 'production');
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173';
const PROJECT_REF = 'thazislrdkjpvvghtvzo';
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const ADMIN_EMAIL = process.env.PLAYWRIGHT_ADMIN_EMAIL ?? 'admin@onecab.net';

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
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  const raw = execSync(`supabase projects api-keys --project-ref ${PROJECT_REF} -o json`, { encoding: 'utf8', cwd: ROOT });
  const parsed = JSON.parse(raw);
  const entry = Array.isArray(parsed) ? parsed.find((k) => k.name === 'service_role') : parsed.keys?.find((k) => k.name === 'service_role');
  return entry?.api_key;
}

async function createSession(email) {
  const admin = createClient(SUPABASE_URL, serviceRoleKey(), { auth: { autoRefreshToken: false, persistSession: false } });
  const pub = createClient(SUPABASE_URL, process.env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  const { data: verified } = await pub.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'email' });
  return verified.session;
}

async function injectSession(page, session) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ k, s }) => localStorage.setItem(k, JSON.stringify({
    access_token: s.access_token, refresh_token: s.refresh_token,
    expires_at: s.expires_at, expires_in: s.expires_in, token_type: s.token_type, user: s.user,
  })), { k: `sb-${PROJECT_REF}-auth-token`, s: session });
}

async function waitSsotTable(page) {
  await page.waitForFunction(() => !document.body.textContent?.includes('Loading SSOT…'), null, { timeout: 120_000 });
  await page.waitForTimeout(2000);
}

async function openDriverDrawer(page, namePattern) {
  let row = page.getByRole('row').filter({ hasText: namePattern }).first();
  if (!(await row.count())) {
    const region = page.getByRole('combobox').filter({ hasText: /region|all regions/i }).first();
    if (await region.count()) {
      await region.click();
      await page.getByRole('option', { name: /milton keynes/i }).click();
      await waitSsotTable(page);
      row = page.getByRole('row').filter({ hasText: namePattern }).first();
    }
  }
  await row.scrollIntoViewIfNeeded();
  await row.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: /Payout & ledger details/i }).click();
  await page.getByRole('dialog').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2000);
}

async function gotoAdminRoute(page, routePath) {
  await page.goto(`${BASE_URL}${routePath}`, { waitUntil: 'networkidle' });
  if (await page.getByText('Oops! Page not found').isVisible().catch(() => false)) {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const link = page.getByRole('link', { name: new RegExp(routePath.slice(1).replace(/-/g, '.*'), 'i') });
    if (await link.count()) {
      await link.first().click();
      await page.waitForLoadState('networkidle');
    }
  }
}

async function main() {
  loadEnv();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

  console.log(`Admin base: ${BASE_URL}`);
  const session = await createSession(ADMIN_EMAIL);
  await injectSession(page, session);

  await gotoAdminRoute(page, '/financial-reconciliation');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(OUT_DIR, '01-financial-reconciliation-ssot.png'), fullPage: true });
  console.log('Saved 01-financial-reconciliation-ssot.png');

  await gotoAdminRoute(page, '/driver-wallet-ledger');
  await waitSsotTable(page);
  await page.screenshot({ path: path.join(OUT_DIR, '02-driver-wallet-ledger-ssot.png'), fullPage: true });
  console.log('Saved 02-driver-wallet-ledger-ssot.png');

  await openDriverDrawer(page, /Ahmed|MK0001/i);
  await page.screenshot({ path: path.join(OUT_DIR, '03-ahmed-local-only-drawer.png'), fullPage: true });
  console.log('Saved 03-ahmed-local-only-drawer.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // Asiya may be on page 2 if pagination with page size 25 shows both - try find row
  let asiya = page.getByRole('row').filter({ hasText: /asiya|MK0002|wehliye/i }).first();
  if (!(await asiya.count())) {
    const next = page.getByRole('button', { name: /^Next$/i });
    if (await next.isEnabled()) {
      await next.click();
      await waitSsotTable(page);
      asiya = page.getByRole('row').filter({ hasText: /asiya|MK0002|wehliye/i }).first();
    }
  }
  if (await asiya.count()) {
    await asiya.scrollIntoViewIfNeeded();
    await asiya.getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('menuitem', { name: /Payout & ledger details/i }).click();
    await page.getByRole('dialog').waitFor();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(OUT_DIR, '04-asiya-balanced-drawer.png'), fullPage: true });
    console.log('Saved 04-asiya-balanced-drawer.png');
  }

  await browser.close();
  console.log(`\nProduction admin screenshots: ${OUT_DIR}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
