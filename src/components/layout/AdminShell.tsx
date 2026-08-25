import { Outlet } from 'react-router-dom';
import { AdminSidebar } from './AdminSidebar';
import { AdminPageAccessGate } from './AdminPageAccessGate';

/**
 * Persistent admin shell layout.
 * Sidebar stays mounted outside <Outlet>; only main content swaps on route change.
 * Page permission denials replace main content only — never the sidebar.
 */
export function AdminShell() {
  return (
    <div className="admin-shell flex h-screen w-full bg-background overflow-hidden">
      <AdminSidebar />
      <main className="admin-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <AdminPageAccessGate>
          <Outlet />
        </AdminPageAccessGate>
      </main>
    </div>
  );
}
