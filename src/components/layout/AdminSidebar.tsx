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
} from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useState, memo, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  badge?: number;
}

// Memoized nav item to prevent unnecessary re-renders
const NavItem = memo(function NavItem({ to, icon, label, active, badge }: NavItemProps) {
  return (
    <Link
      to={to}
      className={cn(
        'flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors',
        active
          ? 'bg-sidebar-accent text-primary'
          : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
      )}
    >
      <div className="flex items-center gap-3">
        {icon}
        <span>{label}</span>
      </div>
      {badge !== undefined && badge > 0 && (
        <Badge variant="secondary" className="bg-primary text-primary-foreground text-xs h-5 min-w-5 flex items-center justify-center">
          {badge > 99 ? '99+' : badge}
        </Badge>
      )}
    </Link>
  );
});

interface NavGroupProps {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

function NavGroup({ label, children, defaultOpen = false }: NavGroupProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

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

function NavSection({ label }: { label: string }) {
  return (
    <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-[hsl(var(--sidebar-muted))]">
      {label}
    </div>
  );
}

export function AdminSidebar() {
  const location = useLocation();
  const { signOut, user } = useAuth();
  const currentPath = location.pathname;

  return (
    <aside className="flex h-screen w-64 min-w-64 max-w-64 flex-col bg-sidebar border-r border-sidebar-border shrink-0">
      {/* Logo */}
      <div className="flex h-16 items-center gap-3 border-b border-sidebar-border px-4 shrink-0">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary">
          <span className="text-lg font-bold text-primary-foreground">OC</span>
        </div>
        <div>
          <h1 className="text-lg font-semibold text-sidebar-foreground">ONECAB</h1>
          <p className="text-xs text-[hsl(var(--sidebar-muted))]">ADMIN PANEL</p>
        </div>
      </div>

      {/* Navigation */}
      <ScrollArea className="flex-1 px-3 py-4">
        <div className="space-y-4">
          {/* DASHBOARD */}
          <div>
            <NavSection label="Dashboard" />
            <NavItem
              to="/dashboard"
              icon={<LayoutDashboard className="h-4 w-4" />}
              label="Main Dashboard"
              active={currentPath === '/dashboard'}
            />
          </div>

          {/* OPERATIONS & DISPATCH */}
          <div>
            <NavSection label="Operations & Dispatch" />
            <div className="space-y-1">
              <NavItem
                to="/fleet-tracking"
                icon={<Send className="h-4 w-4" />}
                label="Live Fleet Tracking"
                active={currentPath === '/fleet-tracking'}
              />
              <NavItem
                to="/active-trips"
                icon={<Radio className="h-4 w-4" />}
                label="Active Trips (Real-time)"
                active={currentPath === '/active-trips'}
                badge={3}
              />
              <NavItem
                to="/auto-dispatch"
                icon={<Target className="h-4 w-4" />}
                label="Auto-Dispatch Rules"
                active={currentPath === '/auto-dispatch'}
              />
              <NavItem
                to="/scheduled-rides"
                icon={<Calendar className="h-4 w-4" />}
                label="Scheduled Rides"
                active={currentPath === '/scheduled-rides'}
                badge={12}
              />
              <NavItem
                to="/missed-cancelled"
                icon={<XCircle className="h-4 w-4" />}
                label="Missed & Canceled"
                active={currentPath === '/missed-cancelled'}
              />
              <NavItem
                to="/trip-history"
                icon={<History className="h-4 w-4" />}
                label="Trip History"
                active={currentPath === '/trip-history'}
              />
              <NavItem
                to="/manual-trip"
                icon={<Plus className="h-4 w-4" />}
                label="Manual Trip Creation"
                active={currentPath === '/manual-trip'}
              />
            </div>
          </div>

          {/* SERVICE AREAS */}
          <div>
            <NavSection label="Service Areas" />
            <div className="space-y-1">
              <NavItem
                to="/regions"
                icon={<MapPin className="h-4 w-4" />}
                label="Regions"
                active={currentPath === '/regions'}
              />
              <NavItem
                to="/services"
                icon={<Map className="h-4 w-4" />}
                label="Services"
                active={currentPath === '/services'}
              />
              <NavItem
                to="/driver-profiles"
                icon={<UserCircle className="h-4 w-4" />}
                label="Driver Profiles"
                active={currentPath === '/driver-profiles'}
              />
              <NavItem
                to="/vehicle-types"
                icon={<CarTaxiFront className="h-4 w-4" />}
                label="Vehicle Types"
                active={currentPath === '/vehicle-types'}
              />
              <NavItem
                to="/documents"
                icon={<FolderOpen className="h-4 w-4" />}
                label="Document Management"
                active={currentPath === '/documents'}
              />
              <NavItem
                to="/driver-categories"
                icon={<Grid3X3 className="h-4 w-4" />}
                label="Driver Categories"
                active={currentPath === '/driver-categories'}
              />
            </div>
          </div>

          {/* PRICING & FARES */}
          <div>
            <NavSection label="Pricing & Fares" />
            <div className="space-y-1">
              <NavItem
                to="/promo-codes"
                icon={<Tag className="h-4 w-4" />}
                label="Promo Codes"
                active={currentPath === '/promo-codes'}
                badge={5}
              />
              <NavItem
                to="/custom-zones"
                icon={<CircleDollarSign className="h-4 w-4" />}
                label="Custom Zones"
                active={currentPath === '/custom-zones'}
              />
              <NavItem
                to="/zone-pricing"
                icon={<Target className="h-4 w-4" />}
                label="Geofence & Zone Pricing"
                active={currentPath === '/zone-pricing'}
              />
              <NavItem
                to="/corporate-fares"
                icon={<Building2 className="h-4 w-4" />}
                label="Corporate Fare Rules"
                active={currentPath === '/corporate-fares'}
              />
              <NavItem
                to="/fare-simulator"
                icon={<Calculator className="h-4 w-4" />}
                label="Fare Simulator"
                active={currentPath === '/fare-simulator'}
              />
            </div>
          </div>

          {/* AIRPORTS & TERMINALS */}
          <div>
            <NavSection label="Airports & Terminals" />
            <div className="space-y-1">
              <NavItem
                to="/airports"
                icon={<Plane className="h-4 w-4" />}
                label="Manage Airports"
                active={currentPath === '/airports'}
              />
            </div>
          </div>

          {/* CORPORATE */}
          <div>
            <NavSection label="Corporate" />
            <div className="space-y-1">
              <NavItem
                to="/corporate-accounts"
                icon={<Briefcase className="h-4 w-4" />}
                label="Corporate Accounts"
                active={currentPath === '/corporate-accounts'}
              />
              <NavItem
                to="/account-requests"
                icon={<FileText className="h-4 w-4" />}
                label="Account Requests"
                active={currentPath === '/account-requests'}
                badge={1}
              />
              <NavItem
                to="/corporate-billing"
                icon={<CreditCard className="h-4 w-4" />}
                label="Corporate Billing"
                active={currentPath === '/corporate-billing'}
              />
              <NavItem
                to="/corporate-reports"
                icon={<BarChart3 className="h-4 w-4" />}
                label="Corporate Reports"
                active={currentPath === '/corporate-reports'}
              />
              <NavItem
                to="/corporate-settings"
                icon={<Settings className="h-4 w-4" />}
                label="Corporate Settings"
                active={currentPath === '/corporate-settings'}
              />
            </div>
          </div>

          {/* USERS & SUPPORT */}
          <div>
            <NavSection label="Users & Support" />
            <div className="space-y-1">
              <NavItem
                to="/riders"
                icon={<Users className="h-4 w-4" />}
                label="Rider Profiles"
                active={currentPath === '/riders'}
              />
              <NavItem
                to="/rider-feedback"
                icon={<MessageSquare className="h-4 w-4" />}
                label="Rider Feedback"
                active={currentPath === '/rider-feedback'}
                badge={8}
              />
              <NavItem
                to="/suspensions"
                icon={<UserX className="h-4 w-4" />}
                label="Account Suspension"
                active={currentPath === '/suspensions'}
              />
              <NavItem
                to="/complaints"
                icon={<AlertTriangle className="h-4 w-4" />}
                label="Complaints Dashboard"
                active={currentPath === '/complaints'}
                badge={2}
              />
              <NavItem
                to="/tickets"
                icon={<Ticket className="h-4 w-4" />}
                label="Tickets"
                active={currentPath === '/tickets'}
                badge={15}
              />
              <NavItem
                to="/categories"
                icon={<Grid3X3 className="h-4 w-4" />}
                label="Categories"
                active={currentPath === '/categories'}
              />
            </div>
          </div>

          {/* FINANCE & PAYOUTS */}
          <div>
            <NavSection label="Finance & Payouts" />
            <div className="space-y-1">
              <NavItem
                to="/payments"
                icon={<Wallet className="h-4 w-4" />}
                label="Payments & Payouts"
                active={currentPath === '/payments'}
              />
              <NavItem
                to="/driver-payouts"
                icon={<DollarSign className="h-4 w-4" />}
                label="Driver Payouts & Settlements"
                active={currentPath === '/driver-payouts'}
                badge={99}
              />
              <NavItem
                to="/disputes"
                icon={<Scale className="h-4 w-4" />}
                label="Disputes & Adjustments"
                active={currentPath === '/disputes'}
              />
              <NavItem
                to="/dispute-settings"
                icon={<Settings className="h-4 w-4" />}
                label="Dispute Settings"
                active={currentPath === '/dispute-settings'}
              />
            </div>
          </div>

          {/* CONTENT & LEGAL */}
          <div>
            <NavSection label="Content & Legal" />
            <div className="space-y-1">
              <NavItem
                to="/content"
                icon={<FileEdit className="h-4 w-4" />}
                label="Manage Content"
                active={currentPath === '/content'}
              />
            </div>
          </div>

          {/* SETTINGS */}
          <div>
            <NavSection label="Settings" />
            <div className="space-y-1">
              <NavItem
                to="/general-settings"
                icon={<Palette className="h-4 w-4" />}
                label="General & Branding"
                active={currentPath === '/general-settings'}
              />
              <NavItem
                to="/integrations"
                icon={<Plug className="h-4 w-4" />}
                label="Integrations & API"
                active={currentPath === '/integrations'}
              />
              <NavItem
                to="/webhooks"
                icon={<Webhook className="h-4 w-4" />}
                label="Webhooks"
                active={currentPath === '/webhooks'}
              />
              <NavItem
                to="/system"
                icon={<Server className="h-4 w-4" />}
                label="System Requirements"
                active={currentPath === '/system'}
              />
              <NavItem
                to="/roles"
                icon={<Shield className="h-4 w-4" />}
                label="Roles & Permissions"
                active={currentPath === '/roles'}
              />
              <NavItem
                to="/notifications"
                icon={<Bell className="h-4 w-4" />}
                label="Notifications & Alerts"
                active={currentPath === '/notifications'}
              />
            </div>
          </div>
        </div>
      </ScrollArea>

      {/* User section */}
      <div className="border-t border-sidebar-border p-4 shrink-0">
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
