import { chromium } from 'playwright';
import fs from 'fs';

const outDir = '/tmp/onecab_smoke_screenshots';
fs.mkdirSync(outDir, { recursive: true });
const sess = JSON.parse(fs.readFileSync('/tmp/onecab_admin_session.json', 'utf8'));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

async function shot(name) {
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
  console.log('saved', name, page.url());
}

await page.goto('https://adminonecab.net/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate((session) => {
  const key = 'sb-thazislrdkjpvvghtvzo-auth-token';
  localStorage.setItem(key, JSON.stringify({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in ?? 3600,
    expires_at: Math.floor(Date.now() / 1000) + (session.expires_in ?? 3600),
    token_type: session.token_type || 'bearer',
    user: session.user,
  }));
}, sess);

await page.goto('https://adminonecab.net/trip-history', { waitUntil: 'networkidle', timeout: 90000 });
await page.waitForTimeout(2500);
// Broaden date filter if present
const selects = page.locator('button[role="combobox"], select');
const count = await selects.count();
for (let i = 0; i < count; i++) {
  const t = await selects.nth(i).innerText().catch(() => '');
  if (/Last 7 Days|7 days|Date/i.test(t)) {
    await selects.nth(i).click();
    await page.waitForTimeout(400);
    const opt = page.getByText(/All time|All Time|Last 30|30 days|This year/i).first();
    if (await opt.count()) await opt.click();
    break;
  }
}
const search = page.locator('input').first();
async function tripShot(q, name) {
  await search.fill('');
  await search.fill(q);
  await page.waitForTimeout(2000);
  await shot(name);
}
await tripShot('BAN-260806-008', '01_customer_A_sent');
await tripShot('BAN-260806-009', '02_stacked_B1_sent');
await tripShot('BAN-260806-010', '03_stacked_B2_sent');
await tripShot('BAN-260806-011', '04_customer_C_no_email');

await page.goto('https://adminonecab.net/invoices', { waitUntil: 'networkidle', timeout: 90000 });
await page.waitForTimeout(2500);
const invSearch = page.locator('input').first();
async function invShot(q, name) {
  await invSearch.fill('');
  await invSearch.fill(q);
  await page.waitForTimeout(1800);
  await shot(name);
}
await invShot('INV-2608-004', '05_driver_D_sent');
await invShot('INV-2608-004', '06_driver_D_rerun_no_dup');
await invShot('INV-2608-005', '07_driver_E_no_email');
await invShot('INV-2608-001', '08_failed_zero_superseded');

await page.goto('https://adminonecab.net/invoice-templates', { waitUntil: 'networkidle', timeout: 90000 });
await page.waitForTimeout(2500);
await shot('10_auto_email_disabled');

await page.goto('https://adminonecab.net/statement-runs', { waitUntil: 'networkidle', timeout: 90000 });
await page.waitForTimeout(2500);
await shot('09_schedule_disabled');

// Try reports route (may 404 on old CDN until Pages finishes)
await page.goto('https://adminonecab.net/driver-earnings-invoices', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1500);
await shot('09b_driver_earnings_reports');

await browser.close();
console.log('done');
