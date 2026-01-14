import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { useSidebarCounts } from '@/hooks/useSidebarCounts';
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
  Send,
  Radio,
  Clock,
  Calendar,
  XCircle,
  Plus,
  Tag,
  CircleDollarSign,
  Target,
  Building2,
  Calculator,
  Plane,
  Briefcase,
  FileText,
  CreditCard,
  BarChart3,
  MessageSquare,
  UserX,
  AlertTriangle,
  Ticket,
  Grid3X3,
  Wallet,
  DollarSign,
  Scale,
  FileEdit,
  Palette,
  Plug,
  Webhook,
  Server,
  Shield,
  Bell,
  FolderOpen,
  UserCircle,
  History,
  PanelLeftClose,
  PanelLeft,
} from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useState, memo, useCallback, useEffect } from 'react';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

const SIDEBAR_COLLAPSED_KEY = 'admin-sidebar-collapsed';

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  badge?: number;
  collapsed?: boolean;
}

// Memoized nav item to prevent unnecessary re-renders
const NavItem = memo(function NavItem({ to, icon, label, active, badge, collapsed }: NavItemProps) {
  const content = (
    <Link
      to={to}
      className={cn(
        'flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors',
        active
          ? 'bg-sidebar-accent text-primary'
          : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        collapsed && 'justify-center px-2'
      )}
    >
      <div className={cn('flex items-center gap-3', collapsed && 'gap-0')}>
        {icon}
        {!collapsed && <span>{label}</span>}
      </div>
      {!collapsed && badge !== undefined && badge > 0 && (
        <Badge variant="secondary" className="bg-primary text-primary-foreground text-xs h-5 min-w-5 flex items-center justify-center">
          {badge > 99 ? '99+' : badge}
        </Badge>
      )}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="right" className="flex items-center gap-2">
          {label}
          {badge !== undefined && badge > 0 && (
            <Badge variant="secondary" className="bg-primary text-primary-foreground text-xs h-5 min-w-5 flex items-center justify-center">
              {badge > 99 ? '99+' : badge}
            </Badge>
          )}
        </TooltipContent>
      </Tooltip>
    );
  }

  return content;
});

interface NavGroupProps {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  collapsed?: boolean;
}

function NavGroup({ label, children, defaultOpen = false, collapsed }: NavGroupProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  if (collapsed) {
    return <div className="space-y-1">{children}</div>;
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wider text-[hsl(var(--sidebar-muted))] hover:text-sidebar-foreground transition-colors">
        <span>{label}</span>
        <ChevronDown
          className={cn(
            'h-3 w-3 transition-transform',
            isOpen && 'rotate-180'
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-1">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

interface NavSectionProps {
  label: string;
  collapsed?: boolean;
}

function NavSection({ label, collapsed }: NavSectionProps) {
  if (collapsed) {
    return <div className="h-px bg-sidebar-border mx-2 my-3" />;
  }

  return (
    <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-[hsl(var(--sidebar-muted))]">
      {label}
    </div>
  );
}

export function AdminSidebar() {
  const location = useLocation();
  const { signOut, user } = useAuth();
  const { counts } = useSidebarCounts();
  const currentPath = location.pathname;
  
  const [isCollapsed, setIsCollapsed] = useState(() => {
    const stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    return stored === 'true';
  });

  const toggleCollapsed = useCallback(() => {
    setIsCollapsed((prev) => {
      const newValue = !prev;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(newValue));
      return newValue;
    });
  }, []);

  return (
    <aside 
      className={cn(
        'flex h-screen flex-col bg-sidebar border-r border-sidebar-border shrink-0 transition-[width] duration-200 ease-in-out',
        isCollapsed ? 'w-16 min-w-16 max-w-16' : 'w-64 min-w-64 max-w-64'
      )}
    >
      {/* Logo */}
      <div className={cn(
        'flex h-16 items-center border-b border-sidebar-border shrink-0',
        isCollapsed ? 'justify-center px-2' : 'gap-3 px-4'
      )}>
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary shrink-0">
          <span className="text-lg font-bold text-primary-foreground">OC</span>
        </div>
        {!isCollapsed && (
          <div>
            <h1 className="text-lg font-semibold text-sidebar-foreground">ONECAB</h1>
            <p className="text-xs text-[hsl(var(--sidebar-muted))]">ADMIN PANEL</p>
          </div>
        )}
      </div>

      {/* Toggle button */}
      <div className={cn(
        'flex shrink-0 border-b border-sidebar-border',
        isCollapsed ? 'justify-center p-2' : 'justify-end px-3 py-2'
      )}>
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-sidebar-foreground hover:bg-sidebar-accent"
              onClick={toggleCollapsed}
            >
              {isCollapsed ? (
                <PanelLeft className="h-4 w-4" />
              ) : (
                <PanelLeftClose className="h-4 w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Navigation */}
      <ScrollArea className="flex-1 px-2 py-4">
        <div className="space-y-4">
          {/* DASHBOARD */}
          <div>
            <NavSection label="Dashboard" collapsed={isCollapsed} />
            <NavItem
              to="/dashboard"
              icon={<LayoutDashboard className="h-4 w-4" />}
              label="Main Dashboard"
              active={currentPath === '/dashboard'}
              collapsed={isCollapsed}
            />
          </div>

          {/* OPERATIONS & DISPATCH */}
          <div>
            <NavSection label="Operations & Dispatch" collapsed={isCollapsed} />
            <div className="space-y-1">
              <NavItem
                to="/fleet-tracking"
                icon={<Send className="h-4 w-4" />}
                label="Live Fleet Tracking"
                active={currentPath === '/fleet-tracking'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/active-trips"
                icon={<Radio className="h-4 w-4" />}
                label="Active Trips (Real-time)"
                active={currentPath === '/active-trips'}
                badge={counts.activeTrips > 0 ? counts.activeTrips : undefined}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/auto-dispatch"
                icon={<Target className="h-4 w-4" />}
                label="Auto-Dispatch Rules"
                active={currentPath === '/auto-dispatch'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/scheduled-rides"
                icon={<Calendar className="h-4 w-4" />}
                label="Scheduled Rides"
                active={currentPath === '/scheduled-rides'}
                badge={counts.scheduledRides > 0 ? counts.scheduledRides : undefined}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/missed-cancelled"
                icon={<XCircle className="h-4 w-4" />}
                label="Missed & Canceled"
                active={currentPath === '/missed-cancelled'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/trip-history"
                icon={<History className="h-4 w-4" />}
                label="Trip History"
                active={currentPath === '/trip-history'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/manual-trip"
                icon={<Plus className="h-4 w-4" />}
                label="Manual Trip Creation"
                active={currentPath === '/manual-trip'}
                collapsed={isCollapsed}
              />
            </div>
          </div>

          {/* SERVICE AREAS */}
          <div>
            <NavSection label="Service Areas" collapsed={isCollapsed} />
            <div className="space-y-1">
              <NavItem
                to="/regions"
                icon={<MapPin className="h-4 w-4" />}
                label="Regions"
                active={currentPath === '/regions'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/services"
                icon={<Map className="h-4 w-4" />}
                label="Services"
                active={currentPath === '/services'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/driver-profiles"
                icon={<UserCircle className="h-4 w-4" />}
                label="Driver Profiles"
                active={currentPath === '/driver-profiles'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/vehicle-types"
                icon={<CarTaxiFront className="h-4 w-4" />}
                label="Vehicle Types"
                active={currentPath === '/vehicle-types'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/documents"
                icon={<FolderOpen className="h-4 w-4" />}
                label="Document Management"
                active={currentPath === '/documents'}
                badge={counts.pendingDocuments > 0 ? counts.pendingDocuments : undefined}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/driver-categories"
                icon={<Grid3X3 className="h-4 w-4" />}
                label="Driver Categories"
                active={currentPath === '/driver-categories'}
                collapsed={isCollapsed}
              />
            </div>
          </div>

          {/* PRICING & FARES */}
          <div>
            <NavSection label="Pricing & Fares" collapsed={isCollapsed} />
            <div className="space-y-1">
              <NavItem
                to="/promo-codes"
                icon={<Tag className="h-4 w-4" />}
                label="Promo Codes"
                active={currentPath === '/promo-codes'}
                badge={counts.activePromoCodes > 0 ? counts.activePromoCodes : undefined}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/custom-zones"
                icon={<CircleDollarSign className="h-4 w-4" />}
                label="Custom Zones"
                active={currentPath === '/custom-zones'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/zone-pricing"
                icon={<Target className="h-4 w-4" />}
                label="Geofence & Zone Pricing"
                active={currentPath === '/zone-pricing'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/corporate-fares"
                icon={<Building2 className="h-4 w-4" />}
                label="Corporate Fare Rules"
                active={currentPath === '/corporate-fares'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/fare-simulator"
                icon={<Calculator className="h-4 w-4" />}
                label="Fare Simulator"
                active={currentPath === '/fare-simulator'}
                collapsed={isCollapsed}
              />
            </div>
          </div>

          {/* AIRPORTS & TERMINALS */}
          <div>
            <NavSection label="Airports & Terminals" collapsed={isCollapsed} />
            <div className="space-y-1">
              <NavItem
                to="/airports"
                icon={<Plane className="h-4 w-4" />}
                label="Manage Airports"
                active={currentPath === '/airports'}
                collapsed={isCollapsed}
              />
            </div>
          </div>

          {/* CORPORATE */}
          <div>
            <NavSection label="Corporate" collapsed={isCollapsed} />
            <div className="space-y-1">
              <NavItem
                to="/corporate-accounts"
                icon={<Briefcase className="h-4 w-4" />}
                label="Corporate Accounts"
                active={currentPath === '/corporate-accounts'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/account-requests"
                icon={<FileText className="h-4 w-4" />}
                label="Account Requests"
                active={currentPath === '/account-requests'}
                badge={counts.pendingAccountRequests}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/corporate-billing"
                icon={<CreditCard className="h-4 w-4" />}
                label="Corporate Billing"
                active={currentPath === '/corporate-billing'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/corporate-reports"
                icon={<BarChart3 className="h-4 w-4" />}
                label="Corporate Reports"
                active={currentPath === '/corporate-reports'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/corporate-settings"
                icon={<Settings className="h-4 w-4" />}
                label="Corporate Settings"
                active={currentPath === '/corporate-settings'}
                collapsed={isCollapsed}
              />
            </div>
          </div>

          {/* USERS & SUPPORT */}
          <div>
            <NavSection label="Users & Support" collapsed={isCollapsed} />
            <div className="space-y-1">
              <NavItem
                to="/riders"
                icon={<Users className="h-4 w-4" />}
                label="Rider Profiles"
                active={currentPath === '/riders'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/rider-feedback"
                icon={<MessageSquare className="h-4 w-4" />}
                label="Rider Feedback"
                active={currentPath === '/rider-feedback'}
                badge={counts.pendingFeedback > 0 ? counts.pendingFeedback : undefined}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/suspensions"
                icon={<UserX className="h-4 w-4" />}
                label="Account Suspension"
                active={currentPath === '/suspensions'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/complaints"
                icon={<AlertTriangle className="h-4 w-4" />}
                label="Complaints Dashboard"
                active={currentPath === '/complaints'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/tickets"
                icon={<Ticket className="h-4 w-4" />}
                label="Tickets"
                active={currentPath === '/tickets'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/categories"
                icon={<Grid3X3 className="h-4 w-4" />}
                label="Categories"
                active={currentPath === '/categories'}
                collapsed={isCollapsed}
              />
            </div>
          </div>

          {/* FINANCE & PAYOUTS */}
          <div>
            <NavSection label="Finance & Payouts" collapsed={isCollapsed} />
            <div className="space-y-1">
              <NavItem
                to="/payments"
                icon={<Wallet className="h-4 w-4" />}
                label="Payments & Payouts"
                active={currentPath === '/payments'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/driver-payouts"
                icon={<DollarSign className="h-4 w-4" />}
                label="Driver Payouts & Settlements"
                active={currentPath === '/driver-payouts'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/disputes"
                icon={<Scale className="h-4 w-4" />}
                label="Disputes & Adjustments"
                active={currentPath === '/disputes'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/dispute-settings"
                icon={<Settings className="h-4 w-4" />}
                label="Dispute Settings"
                active={currentPath === '/dispute-settings'}
                collapsed={isCollapsed}
              />
            </div>
          </div>

          {/* CONTENT & LEGAL */}
          <div>
            <NavSection label="Content & Legal" collapsed={isCollapsed} />
            <div className="space-y-1">
              <NavItem
                to="/content"
                icon={<FileEdit className="h-4 w-4" />}
                label="Manage Content"
                active={currentPath === '/content'}
                collapsed={isCollapsed}
              />
            </div>
          </div>

          {/* SETTINGS */}
          <div>
            <NavSection label="Settings" collapsed={isCollapsed} />
            <div className="space-y-1">
              <NavItem
                to="/general-settings"
                icon={<Palette className="h-4 w-4" />}
                label="General & Branding"
                active={currentPath === '/general-settings'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/integrations"
                icon={<Plug className="h-4 w-4" />}
                label="Integrations & API"
                active={currentPath === '/integrations'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/webhooks"
                icon={<Webhook className="h-4 w-4" />}
                label="Webhooks"
                active={currentPath === '/webhooks'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/system"
                icon={<Server className="h-4 w-4" />}
                label="System Requirements"
                active={currentPath === '/system'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/roles"
                icon={<Shield className="h-4 w-4" />}
                label="Roles & Permissions"
                active={currentPath === '/roles'}
                collapsed={isCollapsed}
              />
              <NavItem
                to="/notifications"
                icon={<Bell className="h-4 w-4" />}
                label="Notifications & Alerts"
                active={currentPath === '/notifications'}
                collapsed={isCollapsed}
              />
            </div>
          </div>
        </div>
      </ScrollArea>

      {/* User section */}
      <div className="border-t border-sidebar-border p-3 shrink-0">
        {isCollapsed ? (
          <div className="flex flex-col items-center gap-2">
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <Link 
                  to="/profile"
                  className={cn(
                    "flex h-9 w-9 items-center justify-center rounded-full bg-sidebar-accent cursor-pointer transition-colors hover:bg-sidebar-accent/80",
                    currentPath === '/profile' && "ring-2 ring-primary"
                  )}
                >
                  <Users className="h-4 w-4 text-sidebar-foreground" />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p className="font-medium">{user?.user_metadata?.display_name || user?.email || 'Admin'}</p>
                <p className="text-xs text-muted-foreground">Administrator - Click to edit profile</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:bg-destructive/10"
                  onClick={signOut}
                >
                  <LogOut className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Sign Out</TooltipContent>
            </Tooltip>
          </div>
        ) : (
          <>
            <Link 
              to="/profile"
              className={cn(
                "mb-3 flex items-center gap-3 rounded-lg p-2 -mx-2 transition-colors hover:bg-sidebar-accent",
                currentPath === '/profile' && "bg-sidebar-accent"
              )}
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 shrink-0">
                <Users className="h-4 w-4 text-primary" />
              </div>
              <div className="flex-1 truncate">
                <p className="text-sm font-medium text-sidebar-foreground truncate">
                  {user?.user_metadata?.display_name || user?.email || 'Admin'}
                </p>
                <p className="text-xs text-[hsl(var(--sidebar-muted))]">Administrator</p>
              </div>
            </Link>
            <button
              onClick={signOut}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-destructive transition-colors hover:bg-destructive/10"
            >
              <LogOut className="h-4 w-4" />
              <span>Sign Out</span>
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
