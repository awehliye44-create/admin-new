import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ADMIN_SIDEBAR_COLLAPSED_PX,
  ADMIN_SIDEBAR_EXPANDED_PX,
  ADMIN_SIDEBAR_ITEM_HEIGHT_PX,
  adminSidebarWidthPx,
} from '../adminSidebarLayout';

describe('admin sidebar layout stability', () => {
  it('locks expanded and collapsed widths', () => {
    expect(ADMIN_SIDEBAR_EXPANDED_PX).toBe(280);
    expect(ADMIN_SIDEBAR_COLLAPSED_PX).toBe(64);
    expect(adminSidebarWidthPx(false)).toBe(280);
    expect(adminSidebarWidthPx(true)).toBe(64);
    expect(ADMIN_SIDEBAR_ITEM_HEIGHT_PX).toBe(44);
  });

  it('does not redefine nav helpers inside AdminSidebar (prevents remount jump)', () => {
    const src = readFileSync(
      resolve(__dirname, '../../components/layout/AdminSidebar.tsx'),
      'utf8',
    );
    // Nested `const P = (` / `const Section = (` remount the whole nav on every route change.
    expect(src).not.toMatch(/const P\s*=\s*\(/);
    expect(src).not.toMatch(/const Section\s*=\s*\(/);
    expect(src).toMatch(/function PermissionNavItem/);
    expect(src).toMatch(/function PermissionSection/);
  });

  it('nav items reserve active border and fixed height', () => {
    const src = readFileSync(
      resolve(__dirname, '../../components/layout/AdminSidebar.tsx'),
      'utf8',
    );
    expect(src).toMatch(/border-l-\[3px\]\s+border-l-transparent/);
    expect(src).toMatch(/h-\[44px\]|h-11/);
    expect(src).toMatch(/scrollbar-gutter:\s*stable|scrollbar-gutter-stable/);
    expect(src).toMatch(/preserveNavScroll/);
    expect(src).toMatch(/admin-sidebar-icon/);
    expect(src).toMatch(/admin-sidebar-section/);
    // Bottom sections that previously jumped
    for (const label of ['Driver Statements', 'ONECAB Documents', 'Content & Legal', 'Settings']) {
      expect(src).toContain(label);
    }
  });

  it('page permission gate is inside shell (not ProtectedRoute)', () => {
    const protectedSrc = readFileSync(
      resolve(__dirname, '../../components/ProtectedRoute.tsx'),
      'utf8',
    );
    const shellSrc = readFileSync(
      resolve(__dirname, '../../components/layout/AdminShell.tsx'),
      'utf8',
    );
    expect(protectedSrc).not.toMatch(/canAccessPage/);
    expect(protectedSrc).not.toMatch(/Restricted Page/);
    expect(shellSrc).toMatch(/AdminPageAccessGate/);
  });

  it('AdminShell keeps sidebar outside Outlet', () => {
    const src = readFileSync(
      resolve(__dirname, '../../components/layout/AdminShell.tsx'),
      'utf8',
    );
    const sidebarMatch = src.match(/^\s*<AdminSidebar\s*\/>/m);
    const outletMatch = src.match(/^\s*<Outlet\s*\/>/m);
    expect(sidebarMatch).toBeTruthy();
    expect(outletMatch).toBeTruthy();
    expect(src.indexOf(sidebarMatch![0])).toBeLessThan(src.indexOf(outletMatch![0]));
    expect(src).toMatch(/admin-main/);
    expect(src).toMatch(/min-w-0/);
  });
});
