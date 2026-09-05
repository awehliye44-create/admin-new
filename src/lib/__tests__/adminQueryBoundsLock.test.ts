/**
 * Lock: Admin high-volume surfaces must stay bounded / count-based.
 * Do not reintroduce unbounded Dashboard / Drivers / Riders / Support / Missed fetches.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_ACTIVE_TRIPS_CAP,
  ADMIN_ACTIVE_TRIPS_ONLINE_DRIVERS_CAP,
  ADMIN_CORPORATE_ACCOUNTS_PAGE_SIZE,
  ADMIN_DASHBOARD_CHART_ROW_CAP,
  ADMIN_DASHBOARD_LIVE_FLEET_CAP,
  ADMIN_DRIVERS_PAGE_SIZE,
  ADMIN_MISSED_CANCELLED_PAGE_SIZE,
  ADMIN_MISSED_CANCELLED_STATS_ROW_CAP,
  ADMIN_RIDERS_PAGE_SIZE,
  ADMIN_SCHEDULED_RIDES_CAP,
  ADMIN_SCHEDULED_RIDES_DRIVERS_CAP,
  ADMIN_SUPPORT_INBOX_PAGE_SIZE,
  ADMIN_SUPPORT_TICKETS_PAGE_SIZE,
} from '@/lib/adminQueryBounds';

const ROOT = path.join(__dirname, '../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('adminQueryBoundsLock', () => {
  it('keeps page / chart caps in the approved bands', () => {
    expect(ADMIN_DRIVERS_PAGE_SIZE).toBe(50);
    expect(ADMIN_RIDERS_PAGE_SIZE).toBe(50);
    expect(ADMIN_SUPPORT_INBOX_PAGE_SIZE).toBe(50);
    expect(ADMIN_MISSED_CANCELLED_PAGE_SIZE).toBe(100);
    expect(ADMIN_DASHBOARD_CHART_ROW_CAP).toBeLessThanOrEqual(2_000);
    expect(ADMIN_DASHBOARD_LIVE_FLEET_CAP).toBeLessThanOrEqual(500);
    expect(ADMIN_ACTIVE_TRIPS_CAP).toBeLessThanOrEqual(500);
    expect(ADMIN_ACTIVE_TRIPS_ONLINE_DRIVERS_CAP).toBeLessThanOrEqual(500);
    expect(ADMIN_SCHEDULED_RIDES_CAP).toBeLessThanOrEqual(500);
    expect(ADMIN_SCHEDULED_RIDES_DRIVERS_CAP).toBeLessThanOrEqual(500);
    expect(ADMIN_SUPPORT_TICKETS_PAGE_SIZE).toBe(50);
    expect(ADMIN_CORPORATE_ACCOUNTS_PAGE_SIZE).toBe(100);
  });

  it('Dashboard uses head-count stats helper — not .limit(10000) trip hydrate', () => {
    const dash = read('src/pages/Dashboard.tsx');
    const stats = read('src/lib/adminDashboardStats.ts');
    expect(dash).toContain('fetchDashboardPeriodStats');
    expect(dash).toContain('fetchDashboardChartRows');
    expect(dash).toContain('ADMIN_DASHBOARD_LIVE_FLEET_CAP');
    expect(dash).not.toMatch(/\.limit\(10000\)/);
    expect(stats).toContain("select('id', { count: 'exact', head: true })");
    expect(stats).toContain('ADMIN_DASHBOARD_CHART_ROW_CAP');
  });

  it('Drivers page uses server-side range pagination', () => {
    const src = read('src/pages/Drivers.tsx');
    expect(src).toContain('ADMIN_DRIVERS_PAGE_SIZE');
    expect(src).toContain('.range(from, to)');
    expect(src).not.toMatch(/rpc\('admin_list_drivers'\)/);
  });

  it('Riders page uses server-side range pagination', () => {
    const src = read('src/pages/Riders.tsx');
    expect(src).toContain('ADMIN_RIDERS_PAGE_SIZE');
    expect(src).toContain('.range(from, to)');
  });

  it('Support inbox is newest-first limited with explicit columns', () => {
    const src = read('src/hooks/useSupportChat.ts');
    expect(src).toContain('ADMIN_SUPPORT_INBOX_PAGE_SIZE');
    expect(src).toContain('.limit(pageSize)');
    expect(src).toContain('id, subject, status, priority, channel');
    expect(src).not.toMatch(/from\("support_conversations"\)\s*\n\s*\.select\("\*"\)/);
    expect(src).not.toMatch(/from\("support_messages"\)\s*\n\s*\.select\("\*"\)/);
    expect(src).not.toMatch(/from\("canned_responses"\)\s*\n\s*\.select\("\*"\)/);
  });

  it('Missed/Cancelled uses ranged pages within the date window', () => {
    const src = read('src/pages/MissedCancelled.tsx');
    expect(src).toContain('ADMIN_MISSED_CANCELLED_PAGE_SIZE');
    expect(src).toContain('.range(from, to)');
  });

  it('Active Trips board is hard-capped (no unbounded live hydrate)', () => {
    const src = read('src/pages/ActiveTrips.tsx');
    expect(src).toContain('ADMIN_ACTIVE_TRIPS_CAP');
    expect(src).toContain('ADMIN_ACTIVE_TRIPS_ONLINE_DRIVERS_CAP');
    expect(src).toContain('.limit(ADMIN_ACTIVE_TRIPS_CAP)');
    expect(src).toContain('.limit(ADMIN_ACTIVE_TRIPS_ONLINE_DRIVERS_CAP)');
  });

  it('Scheduled Rides board is hard-capped', () => {
    const src = read('src/pages/ScheduledRides.tsx');
    expect(src).toContain('ADMIN_SCHEDULED_RIDES_CAP');
    expect(src).toContain('ADMIN_SCHEDULED_RIDES_DRIVERS_CAP');
    expect(src).toContain('.limit(ADMIN_SCHEDULED_RIDES_CAP)');
    expect(src).toContain('.limit(ADMIN_SCHEDULED_RIDES_DRIVERS_CAP)');
  });

  it('Support Tickets board is limited with explicit columns', () => {
    const src = read('src/pages/Tickets.tsx');
    expect(src).toContain('ADMIN_SUPPORT_TICKETS_PAGE_SIZE');
    expect(src).toContain('.limit(ADMIN_SUPPORT_TICKETS_PAGE_SIZE)');
    expect(src).not.toMatch(/from\('support_conversations'\)\s*\n\s*\.select\('\*'\)/);
    expect(src).not.toMatch(/from\('support_messages'\)\s*\n\s*\.select\('\*'\)/);
  });

  it('Corporate Accounts list is limited with explicit columns', () => {
    const src = read('src/pages/CorporateAccounts.tsx');
    expect(src).toContain('ADMIN_CORPORATE_ACCOUNTS_PAGE_SIZE');
    expect(src).toContain('.limit(ADMIN_CORPORATE_ACCOUNTS_PAGE_SIZE)');
    expect(src).not.toMatch(/from\('corporate_accounts'\)\s*\n\s*\.select\('\*'\)/);
  });

  it('Admin pages and hooks avoid select("*")', () => {
    const pagesDir = path.join(ROOT, 'src/pages');
    const hooksDir = path.join(ROOT, 'src/hooks');
    const offenders: string[] = [];
    for (const dir of [pagesDir, hooksDir]) {
      for (const name of fs.readdirSync(dir)) {
        if (!/\.(ts|tsx)$/.test(name)) continue;
        const src = fs.readFileSync(path.join(dir, name), 'utf8');
        if (/\.select\(\s*['"]\*['"]\s*[,)]/.test(src)) {
          offenders.push(path.relative(ROOT, path.join(dir, name)));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('Admin components and lib avoid select("*")', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) {
          if (name === 'node_modules' || name === '__tests__') continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        const src = fs.readFileSync(full, 'utf8');
        if (/\.select\(\s*['"]\*['"]\s*[,)]/.test(src)) {
          offenders.push(path.relative(ROOT, full));
        }
      }
    };
    walk(path.join(ROOT, 'src/components'));
    walk(path.join(ROOT, 'src/lib'));
    expect(offenders).toEqual([]);
  });

  it('Admin pages avoid select template star columns', () => {
    const pagesDir = path.join(ROOT, 'src/pages');
    const offenders: string[] = [];
    for (const name of fs.readdirSync(pagesDir)) {
      if (!/\.(ts|tsx)$/.test(name)) continue;
      const src = fs.readFileSync(path.join(pagesDir, name), 'utf8');
      // Catches `.select(\`*, ...\`)` / indented `*,` PostgREST star hydrates.
      if (/\.select\(\s*`[\s\S]*?^\s*\*,/m.test(src) || /\.select\(\s*`\s*\*/.test(src)) {
        offenders.push(path.join('src/pages', name));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('Invoice preview / templates avoid select("*")', () => {
    const invoices = read('src/pages/Invoices.tsx');
    const templates = read('src/pages/InvoiceTemplates.tsx');
    expect(invoices).not.toMatch(/from\("invoice_items"\)\s*\n\s*\.select\("\*"\)/);
    expect(templates).not.toMatch(/from\("invoice_templates"\)\s*\n\s*\.select\("\*"\)/);
  });

  it('App routes are lazy-loaded (no static page import wall)', () => {
    const app = read('src/App.tsx');
    expect(app).toContain('lazyPage(() => import(');
    expect(app).toContain('Suspense');
    expect(app).not.toMatch(/^import Dashboard from/m);
    expect(app).not.toMatch(/^import Drivers from/m);
    expect(app).not.toMatch(/^import FinancialReconciliation from/m);
  });
});
