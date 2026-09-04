import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { AdminSidebar } from './AdminSidebar';
import { AdminPageAccessGate } from './AdminPageAccessGate';
import { AdminLiveChatWidget } from '@/components/chat/AdminLiveChatWidget';

/**
 * Persistent admin shell layout.
 * Sidebar stays mounted outside <Outlet>; only main content swaps on route change.
 * Lazy page chunks suspend INSIDE main content so the sidebar never disappears.
 * Page permission denials replace main content only — never the sidebar.
 */
export function AdminShell() {
  return (
    <div className="admin-shell flex h-screen w-full bg-background overflow-hidden">
      <AdminSidebar />
      <main className="admin-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <AdminPageAccessGate>
          <Suspense
            fallback={
              <div
                className="flex flex-1 items-center justify-center p-8"
                role="status"
                aria-label="Loading page"
              >
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </AdminPageAccessGate>
      </main>
      <AdminLiveChatWidget />
    </div>
  );
}
