#!/usr/bin/env node
/**
 * Capture SSOT gap-closure verification screenshots (local UI + prod Supabase API).
 */
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots', 'ssot-gap-closure');
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173';
const PROJECT_REF = 'thazislrdkjpvvghtvzo';
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const ADMIN_EMAIL = process.env.PLAYWRIGHT_ADMIN_EMAIL ?? 'admin@onecab.net';
const MK_REGION = '7f611e59-a9e5-42c2-b65a-61376910bb5d';

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

async function createSession() {
  const admin = createClient(SUPABASE_URL, serviceRoleKey(), { auth: { autoRefreshToken: false, persistSession: false } });
  const pub = createClient(SUPABASE_URL, process.env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: link, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: ADMIN_EMAIL });
  if (error || !link?.properties?.hashed_token) throw new Error(`admin link failed: ${error?.message}`);
  const { data: verified, error: otpErr } = await pub.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
  if (otpErr || !verified.session) throw new Error(`admin session failed: ${otpErr?.message}`);
  return verified.session;
}

async function injectSession(page, session) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ k, s }) => localStorage.setItem(k, JSON.stringify({
    access_token: s.access_token, refresh_token: s.refresh_token,
    expires_at: s.expires_at, expires_in: s.expires_in, token_type: s.token_type, user: s.user,
  })), { k: `sb-${PROJECT_REF}-auth-token`, s: session });
}

async function startPreview() {
  if (process.env.PLAYWRIGHT_BASE_URL) return null;
  const child = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', '4173'], {
    cwd: ROOT, stdio: 'pipe', shell: true,
  });
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(BASE_URL);
      if (res.ok) return child;
    } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error('Preview server did not start');
}

const results = [];

function record(id, pass, detail) {
  results.push({ id, pass, detail });
}

async function main() {
  loadEnv();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startPreview();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const session = await createSession();
  await injectSession(page, session);

  // 1. FR Overview — Milton Keynes region for KPIs
  await page.goto(`${BASE_URL}/financial-reconciliation?tab=overview`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const regionCombo = page.locator('button[role="combobox"]').first();
  if (await regionCombo.count()) {
    await regionCombo.click();
    const mkOpt = page.getByRole('option', { name: /milton keynes/i });
    if (await mkOpt.count()) await mkOpt.click();
  }
  await page.waitForTimeout(8000);
  const overviewText = await page.locator('main').innerText();
  record('1-fr-overview-kpis', overviewText.includes('Balanced Drivers') && overviewText.includes('admin-finance-reconciliation SSOT'), overviewText.includes('drivers)') ? overviewText.match(/\(.*drivers\)/)?.[0] ?? 'kpis loaded' : overviewText.slice(0, 120));
  await page.screenshot({ path: path.join(OUT_DIR, '01-fr-overview-platform-kpis.png'), fullPage: true });

  // 2. FR Trips
  await page.goto(`${BASE_URL}/financial-reconciliation?tab=trips`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(5000);
  const tripsHeaders = await page.locator('table thead').innerText();
  const tripsOk = ['Gross Fare', 'Discount', 'Final Fare', 'Commission', 'Driver Net'].every((h) => tripsHeaders.includes(h));
  record('2-fr-trips-columns', tripsOk, tripsHeaders.replace(/\s+/g, ' '));
  await page.screenshot({ path: path.join(OUT_DIR, '02-fr-trips-ssot-columns.png'), fullPage: true });

  // 3. FR Alerts
  await page.goto(`${BASE_URL}/financial-reconciliation?tab=alerts`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  const alertsText = await page.locator('main').innerText();
  const alertsOk = !alertsText.includes('Legacy manual review') && !alertsText.includes('continuous reconciliation compare');
  record('3-fr-alerts-spec-only', alertsOk, alertsOk ? 'No legacy/banner sections' : 'Found forbidden sections');
  await page.screenshot({ path: path.join(OUT_DIR, '03-fr-alerts-spec-only.png'), fullPage: true });

  // 4. Annual Taxi Report — select driver (2nd combobox) then generate
  await page.goto(`${BASE_URL}/annual-taxi-report`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const driverTrigger = page.locator('label:has-text("Driver")').locator('..').locator('button[role="combobox"]');
  if (await driverTrigger.count()) {
    await driverTrigger.click();
    await page.getByRole('option').first().click();
  }
  await page.getByRole('button', { name: /generate report/i }).click({ timeout: 15000 });
  await page.waitForTimeout(8000);
  const annualHeaders = (await page.locator('table thead').count()) ? await page.locator('table thead').innerText() : '';
  const annualOk = annualHeaders.includes('Financial Reconciliation') && !annualHeaders.includes('Driver Net') && !annualHeaders.includes('ONECAB Commission');
  record('4-annual-taxi-report', annualOk, annualHeaders.replace(/\s+/g, ' ') || 'no table');
  await page.screenshot({ path: path.join(OUT_DIR, '04-annual-taxi-fr-link.png'), fullPage: true });

  const MK_DRIVER = '5ed232c3-8bb5-4085-95d6-73e48e6c5e28';

  // 5. Driver Wallet Ledger overview
  await page.goto(`${BASE_URL}/driver-wallet-ledger?driverId=${MK_DRIVER}&tab=overview`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Σ driver_wallet_ledger', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const dwlText = await page.locator('main').innerText();
  const dwlOk = dwlText.includes('Σ driver_wallet_ledger') && dwlText.includes('min(wallet, finance cleared');
  record('5-dwl-overview-formulas', dwlOk, dwlOk ? 'Formula subtitles visible' : dwlText.slice(0, 200));
  await page.screenshot({ path: path.join(OUT_DIR, '05-dwl-overview-formulas.png'), fullPage: true });

  // 6. DWL Payouts batch
  await page.goto(`${BASE_URL}/driver-wallet-ledger?driverId=${MK_DRIVER}&tab=payouts`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Current batch', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const payoutsText = await page.locator('main').innerText();
  record('6-dwl-payouts-batches', payoutsText.includes('Current batch') && payoutsText.includes('Batch status'), payoutsText.slice(0, 200));
  await page.screenshot({ path: path.join(OUT_DIR, '06-dwl-payouts-batches.png'), fullPage: true });

  // 7. FR Stripe Connect full list
  await page.goto(`${BASE_URL}/financial-reconciliation?tab=stripe`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  await page.getByRole('tab', { name: /Connect reconciliation/i }).click();
  await page.waitForTimeout(3000);
  const stripeText = await page.locator('main').innerText();
  const connectRows = await page.locator('table tbody tr').count();
  record('7-fr-stripe-connect-all', connectRows >= 2, `${connectRows} connect account rows visible`);
  await page.screenshot({ path: path.join(OUT_DIR, '07-fr-stripe-connect-accounts.png'), fullPage: true });

  await browser.close();
  if (preview) preview.kill();

  const allPass = results.every((r) => r.pass);
  fs.writeFileSync(path.join(OUT_DIR, 'verification-results.json'), JSON.stringify({ allPass, results }, null, 2));
  console.log(JSON.stringify({ allPass, results, screenshots: OUT_DIR }, null, 2));
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
