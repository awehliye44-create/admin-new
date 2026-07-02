#!/usr/bin/env node
/**
 * Driver wallet screenshot — prod driver-wallet-summary API + faithful UI render.
 * (Full app route crashes on committedJob in current drive-hub-buddy build.)
 */
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../docs/screenshots/production');
const PROJECT_REF = 'thazislrdkjpvvghtvzo';
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const DRIVER_EMAIL = process.env.PLAYWRIGHT_DRIVER_EMAIL ?? 'bookings@onecab.net';

function loadEnv(root) {
  for (const name of ['.env', '.env.local']) {
    const p = path.join(root, name);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

function serviceRoleKey(cwd) {
  const raw = execSync(`supabase projects api-keys --project-ref ${PROJECT_REF} -o json`, { encoding: 'utf8', cwd });
  const parsed = JSON.parse(raw);
  const entry = Array.isArray(parsed) ? parsed.find((k) => k.name === 'service_role') : parsed.keys?.find((k) => k.name === 'service_role');
  return entry?.api_key;
}

function gbp(pence) {
  return `£${(pence / 100).toFixed(2)}`;
}

function walletHtml(summary) {
  const wallet = summary.net_balance_pence ?? 0;
  const financeCleared = summary.settled_eligible_driver_funds_pence ?? summary.settled_card_driver_earnings_pence ?? 0;
  const scheduled = summary.next_weekly_payout_pence ?? 0;
  const cashoutLimit = summary.available_now_pence ?? summary.available_payout_pence ?? 0;
  const cashoutLabel = summary.cash_out_available ? 'Available' : 'Unavailable';
  const scheduledLabel = scheduled > 0 ? gbp(scheduled) : 'Not yet scheduled';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  *{box-sizing:border-box} body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#0f1115;color:#f4f4f5;min-height:100vh}
  .bar{padding:14px 16px;font-weight:600;border-bottom:1px solid #27272a;display:flex;align-items:center;gap:8px}
  .wrap{padding:16px;max-width:420px;margin:0 auto}
  .section{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#a1a1aa;margin:8px 4px 12px}
  .card{border:1px solid #27272a;border-radius:12px;padding:16px;margin-bottom:12px;background:#18181b}
  .card.blue{background:rgba(59,130,246,.08);border-color:rgba(59,130,246,.35)}
  .card.amber{background:rgba(245,158,11,.08);border-color:rgba(245,158,11,.35)}
  .title{font-size:14px;color:#a1a1aa;margin:0 0 6px}
  .amount{font-size:28px;font-weight:700;margin:0}
  .hint{font-size:12px;color:#71717a;margin:8px 0 0;line-height:1.4}
  .chip{display:inline-block;margin-top:8px;padding:2px 8px;border-radius:999px;font-size:11px;background:#27272a;color:#d4d4d8}
  .foot{font-size:12px;color:#71717a;margin-top:16px;line-height:1.5;padding:0 4px}
  .badge{display:inline-block;background:#16a34a33;color:#4ade80;font-size:11px;padding:2px 8px;border-radius:999px;margin-left:8px}
</style></head><body>
<div class="bar">← Wallet</div>
<div class="wrap">
  <p class="section">Your wallet</p>
  <div class="card blue">
    <p class="title">Wallet balance</p>
    <p class="amount">${gbp(wallet)}</p>
    <p class="hint">ONECAB wallet balance owed from card trips, tips, payouts, and adjustments. This is not your Stripe bank balance.</p>
  </div>
  <div class="card">
    <p class="title">Finance cleared <span class="badge">Finance-cleared</span></p>
    <p class="amount">${gbp(financeCleared)}</p>
    <p class="hint">Settlements cleared for payout eligibility — separate from wallet balance and Stripe cash.</p>
  </div>
  <div class="card">
    <p class="title">Included in scheduled payout</p>
    <p class="amount">${scheduledLabel}</p>
    <p class="hint">Weekly batch payout — separate from wallet balance and instant cash-out limit.</p>
  </div>
  <div class="card amber">
    <p class="title">Available to cash out now</p>
    <p class="amount">${gbp(cashoutLimit)}</p>
    <span class="chip">${cashoutLabel}</span>
    <p class="hint">${summary.cashout_reason ?? 'Cash-out limit from Stripe Connect — not the same as wallet balance.'}</p>
  </div>
  <p class="foot">Your wallet balance shows what you earned. Stripe balances show what can actually be paid out now.</p>
  <p class="foot" style="color:#52525b">Prod API: driver-wallet-summary · ${DRIVER_EMAIL} · ${new Date().toISOString().slice(0, 19)}Z</p>
</div></body></html>`;
}

async function main() {
  const adminRoot = path.resolve(__dirname, '..');
  loadEnv(adminRoot);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const admin = createClient(SUPABASE_URL, serviceRoleKey(adminRoot), { auth: { autoRefreshToken: false, persistSession: false } });
  const pub = createClient(SUPABASE_URL, process.env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: DRIVER_EMAIL });
  const { data: verified } = await pub.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'email' });
  const token = verified.session.access_token;

  const res = await fetch(`${SUPABASE_URL}/functions/v1/driver-wallet-summary`, {
    headers: { Authorization: `Bearer ${token}`, apikey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY },
  });
  if (!res.ok) throw new Error(`driver-wallet-summary ${res.status}: ${await res.text()}`);
  const summary = await res.json();

  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  await page.setContent(walletHtml(summary), { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(OUT_DIR, '05-driver-app-wallet-ssot.png'), fullPage: true });
  await browser.close();
  console.log('Saved 05-driver-app-wallet-ssot.png');
  console.log(`wallet=${gbp(summary.net_balance_pence)} cashout_limit=${gbp(summary.available_now_pence)} scheduled=${gbp(summary.next_weekly_payout_pence)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
