import { Outlet } from 'react-router-dom';
import { AdminSidebar } from './AdminSidebar';

/**
 * Persistent admin shell layout.
 * Sidebar + header remain mounted; only the content area changes via <Outlet>.
 * This prevents layout jumps and sidebar re-renders on navigation.
 */
export function AdminShell() {
  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      {/* Sidebar - always mounted, fixed width */}
      <AdminSidebar />
      
      {/* Main content area - only this changes on route */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
