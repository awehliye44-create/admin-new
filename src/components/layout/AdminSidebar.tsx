import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import {
  LayoutDashboard,
  Users,
  Car,
  MapPin,
  Map,
  CarTaxiFront,
  Navigation,
  Settings,
  LogOut,
  ChevronDown,
} from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useState } from 'react';

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  active?: boolean;
}

function NavItem({ to, icon, label, active }: NavItemProps) {
  return (
    <Link
      to={to}
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
        active
          ? 'bg-sidebar-accent text-primary'
          : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
      )}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}

interface NavGroupProps {
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

function NavGroup({ label, icon, children, defaultOpen = false }: NavGroupProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent">
        <div className="flex items-center gap-3">
          {icon}
          <span>{label}</span>
        </div>
        <ChevronDown
          className={cn(
            'h-4 w-4 transition-transform',
            isOpen && 'rotate-180'
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-4 mt-1 space-y-1 border-l border-sidebar-border pl-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function AdminSidebar() {
  const location = useLocation();
  const { signOut, user } = useAuth();
  const currentPath = location.pathname;

  return (
    <aside className="flex h-screen w-64 flex-col bg-sidebar border-r border-sidebar-border">
      {/* Logo */}
      <div className="flex h-16 items-center gap-3 border-b border-sidebar-border px-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary">
          <span className="text-lg font-bold text-primary-foreground">OC</span>
        </div>
        <div>
          <h1 className="text-lg font-semibold text-sidebar-foreground">ONECAB</h1>
          <p className="text-xs text-[hsl(var(--sidebar-muted))]">Admin Panel</p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto p-4 space-y-2">
        <NavItem
          to="/dashboard"
          icon={<LayoutDashboard className="h-5 w-5" />}
          label="Dashboard"
          active={currentPath === '/dashboard'}
        />

        <NavGroup
          label="Fleet Management"
          icon={<Car className="h-5 w-5" />}
          defaultOpen={currentPath.includes('/drivers') || currentPath.includes('/vehicles')}
        >
          <NavItem
            to="/drivers"
            icon={<Users className="h-4 w-4" />}
            label="Drivers"
            active={currentPath === '/drivers'}
          />
          <NavItem
            to="/vehicles"
            icon={<CarTaxiFront className="h-4 w-4" />}
            label="Vehicles"
            active={currentPath === '/vehicles'}
          />
        </NavGroup>

        <NavItem
          to="/riders"
          icon={<Users className="h-5 w-5" />}
          label="Riders"
          active={currentPath === '/riders'}
        />

        <NavGroup
          label="Service Areas"
          icon={<Map className="h-5 w-5" />}
          defaultOpen={currentPath.includes('/regions') || currentPath.includes('/services')}
        >
          <NavItem
            to="/regions"
            icon={<MapPin className="h-4 w-4" />}
            label="Regions"
            active={currentPath === '/regions'}
          />
          <NavItem
            to="/services"
            icon={<Navigation className="h-4 w-4" />}
            label="Service Areas"
            active={currentPath === '/services'}
          />
        </NavGroup>

        <NavItem
          to="/dispatch"
          icon={<Navigation className="h-5 w-5" />}
          label="Dispatch"
          active={currentPath === '/dispatch'}
        />

        <NavItem
          to="/settings"
          icon={<Settings className="h-5 w-5" />}
          label="Settings"
          active={currentPath === '/settings'}
        />
      </nav>

      {/* User section */}
      <div className="border-t border-sidebar-border p-4">
        <div className="mb-3 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-sidebar-accent">
            <Users className="h-4 w-4 text-sidebar-foreground" />
          </div>
          <div className="flex-1 truncate">
            <p className="text-sm font-medium text-sidebar-foreground truncate">
              {user?.email || 'Admin'}
            </p>
            <p className="text-xs text-[hsl(var(--sidebar-muted))]">Administrator</p>
          </div>
        </div>
        <button
          onClick={signOut}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-destructive transition-colors hover:bg-destructive/10"
        >
          <LogOut className="h-4 w-4" />
          <span>Sign Out</span>
        </button>
      </div>
    </aside>
  );
}
