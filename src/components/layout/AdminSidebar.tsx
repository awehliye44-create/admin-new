import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { useStaffProfile } from '@/hooks/useStaffProfile';
import { useSidebarCounts } from '@/hooks/useSidebarCounts';
import { useLostPropertyUnreadCount } from '@/hooks/useLostProperty';
import { useChatUnreadCount } from '@/hooks/useChatUnreadCount';
import {
  LayoutDashboard,
  Users,
  Car,
  MapPin,
  Map,
  CarTaxiFront,
  Navigation,
  Settings,
  Settings2,
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
  Volume2,
  FolderOpen,
  UserCircle,
  History,
  PanelLeftClose,
  PanelLeft,
  ShieldCheck,
  Contact,
  QrCode,
  BrainCircuit,
  Smartphone,
  Globe,
  PackageSearch,
  Sparkles,
  Gauge,
  Activity,
  Flame,
  Store,
  Coins,
  Lock,
  UserPlus,
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
  badgeColor?: 'primary' | 'destructive';
  collapsed?: boolean;
}

// Memoized nav item to prevent unnecessary re-renders
const NavItem = memo(function NavItem({ to, icon, label, active, badge, badgeColor = 'primary', collapsed }: NavItemProps) {
  const badgeClass = badgeColor === 'destructive'
    ? 'bg-destructive text-destructive-foreground text-xs h-5 min-w-5 flex items-center justify-center'
    : 'bg-primary text-primary-foreground text-xs h-5 min-w-5 flex items-center justify-center';
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
        <Badge variant="secondary" className={badgeClass}>
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
            <Badge variant="secondary" className={badgeClass}>
              {badge > 99 ? '99+' : badge}
            </Badge>
          )}
        </TooltipContent>
      </Tooltip>
    );
  }

  return content;
});

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
  const { canAccessPage, staffProfile } = useStaffProfile();
  const { counts } = useSidebarCounts();
  const lpUnread = useLostPropertyUnreadCount();
  const chatUnread = useChatUnreadCount();
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

  // Permission-filtered nav item
  const P = ({ pageSlug, ...props }: NavItemProps & { pageSlug: string }) => {
    if (!canAccessPage(pageSlug)) return null;
    return <NavItem {...props} />;
  };

  // Section wrapper — hides itself when no child slug is accessible
  const Section = ({ label, slugs, children }: { label: string; slugs: string[]; children: React.ReactNode }) => {
    if (!slugs.some((s) => canAccessPage(s))) return null;
    return (
      <div>
        <NavSection label={label} collapsed={isCollapsed} />
        <div className="space-y-1">{children}</div>
      </div>
    );
  };

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
          <Section label="Dashboard" slugs={['dashboard']}>
            <P pageSlug="dashboard" to="/dashboard" icon={<LayoutDashboard className="h-4 w-4" />} label="Main Dashboard" active={currentPath === '/dashboard'} collapsed={isCollapsed} />
          </Section>

          {/* OPERATIONS & DISPATCH */}
          <Section
            label="Operations & Dispatch"
            slugs={['fleet-tracking','active-trips','scheduled-rides','missed-cancelled','trip-history','manual-trip','qr-booking','dispatch-metrics','driver-demand-zones']}
          >
            <P pageSlug="fleet-tracking" to="/fleet-tracking" icon={<Send className="h-4 w-4" />} label="Live Fleet Tracking" active={currentPath === '/fleet-tracking'} collapsed={isCollapsed} />
            <P pageSlug="active-trips" to="/active-trips" icon={<Radio className="h-4 w-4" />} label="Active Trips (Real-time)" active={currentPath === '/active-trips'} badge={counts.activeTrips > 0 ? counts.activeTrips : undefined} collapsed={isCollapsed} />
            <P pageSlug="scheduled-rides" to="/scheduled-rides" icon={<Calendar className="h-4 w-4" />} label="Scheduled Rides" active={currentPath === '/scheduled-rides'} badge={counts.scheduledRides > 0 ? counts.scheduledRides : undefined} collapsed={isCollapsed} />
            <P pageSlug="missed-cancelled" to="/missed-cancelled" icon={<XCircle className="h-4 w-4" />} label="Missed & Canceled" active={currentPath === '/missed-cancelled'} collapsed={isCollapsed} />
            <P pageSlug="trip-history" to="/trip-history" icon={<History className="h-4 w-4" />} label="Trip History" active={currentPath === '/trip-history'} collapsed={isCollapsed} />
            <P pageSlug="manual-trip" to="/manual-trip" icon={<Plus className="h-4 w-4" />} label="Manual Trip Creation" active={currentPath === '/manual-trip'} collapsed={isCollapsed} />
            <P pageSlug="qr-booking" to="/qr-booking" icon={<QrCode className="h-4 w-4" />} label="QR Booking" active={currentPath === '/qr-booking'} collapsed={isCollapsed} />
            <P pageSlug="dispatch-metrics" to="/dispatch-metrics" icon={<Activity className="h-4 w-4" />} label="Dispatch Metrics" active={currentPath === '/dispatch-metrics'} collapsed={isCollapsed} />
            <P pageSlug="driver-demand-zones" to="/driver-demand-zones" icon={<Flame className="h-4 w-4" />} label="Driver Demand Zones" active={currentPath === '/driver-demand-zones'} collapsed={isCollapsed} />
          </Section>

          {/* FLEET MANAGEMENT */}
          <Section label="Fleet Management" slugs={['drivers','vehicles','vehicle-types','documents','document-management']}>
            <P pageSlug="drivers" to="/drivers" icon={<UserCircle className="h-4 w-4" />} label="Driver List" active={currentPath === '/drivers'} badge={counts.pendingDrivers > 0 ? counts.pendingDrivers : undefined} collapsed={isCollapsed} />
            <P pageSlug="vehicles" to="/vehicles" icon={<Car className="h-4 w-4" />} label="Vehicle List" active={currentPath === '/vehicles'} badge={counts.pendingVehicleChanges > 0 ? counts.pendingVehicleChanges : undefined} collapsed={isCollapsed} />
            <P pageSlug="vehicle-types" to="/vehicle-types" icon={<CarTaxiFront className="h-4 w-4" />} label="Vehicle Types" active={currentPath === '/vehicle-types'} collapsed={isCollapsed} />
            <P pageSlug="documents" to="/documents" icon={<FolderOpen className="h-4 w-4" />} label="Document Review" active={currentPath === '/documents'} badge={counts.pendingDocuments > 0 ? counts.pendingDocuments : undefined} collapsed={isCollapsed} />
            <P pageSlug="document-management" to="/document-management" icon={<Settings2 className="h-4 w-4" />} label="Document Management" active={currentPath === '/document-management'} collapsed={isCollapsed} />
          </Section>


          {/* SERVICE AREAS */}
          <Section label="Service Areas" slugs={['regions','services']}>
            <P pageSlug="regions" to="/regions" icon={<MapPin className="h-4 w-4" />} label="Regions" active={currentPath === '/regions'} collapsed={isCollapsed} />
            <P pageSlug="services" to="/services" icon={<Map className="h-4 w-4" />} label="Services" active={currentPath === '/services'} collapsed={isCollapsed} />
          </Section>

          {/* PRICING & FARES */}
          <Section label="Pricing & Fares" slugs={['promo-codes','offers','custom-zones','zone-pricing','fare-simulator']}>
            <P pageSlug="promo-codes" to="/promo-codes" icon={<Tag className="h-4 w-4" />} label="Promo Codes" active={currentPath === '/promo-codes'} badge={counts.activePromoCodes > 0 ? counts.activePromoCodes : undefined} collapsed={isCollapsed} />
            <P pageSlug="offers" to="/offers" icon={<Sparkles className="h-4 w-4" />} label="Customer Offers" active={currentPath === '/offers'} collapsed={isCollapsed} />
            <P pageSlug="custom-zones" to="/custom-zones" icon={<CircleDollarSign className="h-4 w-4" />} label="Custom Zones" active={currentPath === '/custom-zones'} collapsed={isCollapsed} />
            <P pageSlug="zone-pricing" to="/zone-pricing" icon={<Target className="h-4 w-4" />} label="Geofence & Zone Pricing" active={currentPath === '/zone-pricing'} collapsed={isCollapsed} />
            <P pageSlug="fare-simulator" to="/fare-simulator" icon={<Calculator className="h-4 w-4" />} label="Fare Simulator" active={currentPath === '/fare-simulator'} collapsed={isCollapsed} />
          </Section>

          {/* CORPORATE */}
          <Section label="Corporate" slugs={['corporate-accounts','account-requests','corporate-billing','corporate-reports','corporate-fares','corporate-settings']}>
            <P pageSlug="corporate-accounts" to="/corporate-accounts" icon={<Briefcase className="h-4 w-4" />} label="Corporate Accounts" active={currentPath === '/corporate-accounts'} collapsed={isCollapsed} />
            <P pageSlug="account-requests" to="/account-requests" icon={<FileText className="h-4 w-4" />} label="Account Requests" active={currentPath === '/account-requests'} badge={counts.pendingAccountRequests} collapsed={isCollapsed} />
            <P pageSlug="corporate-billing" to="/corporate-billing" icon={<CreditCard className="h-4 w-4" />} label="Corporate Billing" active={currentPath === '/corporate-billing'} collapsed={isCollapsed} />
            <P pageSlug="corporate-reports" to="/corporate-reports" icon={<BarChart3 className="h-4 w-4" />} label="Corporate Reports" active={currentPath === '/corporate-reports'} collapsed={isCollapsed} />
            <P pageSlug="corporate-fares" to="/corporate-fares" icon={<Building2 className="h-4 w-4" />} label="Corporate Fare Rules" active={currentPath === '/corporate-fares'} collapsed={isCollapsed} />
            <P pageSlug="corporate-settings" to="/corporate-settings" icon={<Settings className="h-4 w-4" />} label="Corporate Settings" active={currentPath === '/corporate-settings'} collapsed={isCollapsed} />
          </Section>

          {/* RIDER MANAGEMENT */}
          <Section label="Rider Management" slugs={['riders','pending-customer-signups','rider-feedback']}>
            <P pageSlug="riders" to="/riders" icon={<Users className="h-4 w-4" />} label="Rider List" active={currentPath === '/riders'} collapsed={isCollapsed} />
            <P pageSlug="pending-customer-signups" to="/pending-customer-signups" icon={<UserPlus className="h-4 w-4" />} label="Pending Signups" active={currentPath === '/pending-customer-signups'} collapsed={isCollapsed} />
            <P pageSlug="rider-feedback" to="/rider-feedback" icon={<MessageSquare className="h-4 w-4" />} label="Rider Feedback" active={currentPath === '/rider-feedback'} badge={counts.pendingFeedback > 0 ? counts.pendingFeedback : undefined} collapsed={isCollapsed} />
          </Section>

          {/* SUPPORT */}
          <Section label="Support" slugs={['suspensions','complaints','live-chat','tickets','lost-property','categories']}>
            <P pageSlug="suspensions" to="/suspensions" icon={<UserX className="h-4 w-4" />} label="Account Suspension" active={currentPath === '/suspensions'} collapsed={isCollapsed} />
            <P pageSlug="complaints" to="/complaints" icon={<AlertTriangle className="h-4 w-4" />} label="Complaints Dashboard" active={currentPath === '/complaints'} collapsed={isCollapsed} />
            <P pageSlug="live-chat" to="/live-chat" icon={<MessageSquare className="h-4 w-4" />} label="Live Chat" active={currentPath === '/live-chat'} badge={chatUnread > 0 ? chatUnread : undefined} badgeColor="destructive" collapsed={isCollapsed} />
            <P pageSlug="tickets" to="/tickets" icon={<Ticket className="h-4 w-4" />} label="Tickets" active={currentPath === '/tickets'} collapsed={isCollapsed} />
            <P pageSlug="lost-property" to="/lost-property" icon={<PackageSearch className="h-4 w-4" />} label="Lost Property" active={currentPath === '/lost-property' || currentPath.startsWith('/lost-property/')} badge={lpUnread > 0 ? lpUnread : undefined} badgeColor="destructive" collapsed={isCollapsed} />
            <P pageSlug="categories" to="/categories" icon={<Grid3X3 className="h-4 w-4" />} label="Support Categories" active={currentPath === '/categories'} collapsed={isCollapsed} />
          </Section>

          {/* PAYMENTS & TRANSACTIONS (SSOT) */}
          <Section label="Payments & Transactions" slugs={['driver-wallet-ledger','financial-reconciliation']}>
            <P pageSlug="driver-wallet-ledger" to="/driver-wallet-ledger" icon={<Wallet className="h-4 w-4" />} label="Driver Wallet Ledger (SSOT)" active={currentPath === '/driver-wallet-ledger'} collapsed={isCollapsed} />
            <P pageSlug="financial-reconciliation" to="/financial-reconciliation" icon={<Calculator className="h-4 w-4" />} label="Financial Reconciliation (SSOT)" active={currentPath === '/financial-reconciliation'} collapsed={isCollapsed} />
          </Section>

          {/* REPORTS */}
          <Section label="Reports" slugs={['annual-taxi-report','onecab-revenue-profit']}>
            <P pageSlug="annual-taxi-report" to="/annual-taxi-report" icon={<FileText className="h-4 w-4" />} label="Annual Taxi Report" active={currentPath === '/annual-taxi-report'} collapsed={isCollapsed} />
            <P pageSlug="onecab-revenue-profit" to="/onecab-revenue-profit" icon={<BarChart3 className="h-4 w-4" />} label="ONECAB Revenue & Profit" active={currentPath === '/onecab-revenue-profit'} collapsed={isCollapsed} />
          </Section>

          {/* ONECAB DOCUMENTS */}
          <Section label="ONECAB Documents" slugs={['onecab-documents']}>
            <P pageSlug="onecab-documents" to="/onecab-documents" icon={<ShieldCheck className="h-4 w-4" />} label="Compliance Center" active={currentPath === '/onecab-documents'} collapsed={isCollapsed} />
          </Section>

          {/* CONTENT & LEGAL */}
          <Section label="Content & Legal" slugs={['content']}>
            <P pageSlug="content" to="/content" icon={<FileEdit className="h-4 w-4" />} label="Manage Content" active={currentPath === '/content'} collapsed={isCollapsed} />
          </Section>

          {/* OPS INTELLIGENCE */}
          <Section label="Ops Intelligence" slugs={['ops-intelligence']}>
            <P pageSlug="ops-intelligence" to="/ops-intelligence" icon={<BrainCircuit className="h-4 w-4" />} label="Ops Dashboard" active={currentPath === '/ops-intelligence' && !location.search.includes('tab=')} collapsed={isCollapsed} />
            <P pageSlug="ops-intelligence" to="/ops-intelligence?tab=driver-app" icon={<Car className="h-4 w-4" />} label="Driver App" active={currentPath === '/ops-intelligence' && location.search.includes('tab=driver-app')} collapsed={isCollapsed} />
            <P pageSlug="ops-intelligence" to="/ops-intelligence?tab=customer-app" icon={<Smartphone className="h-4 w-4" />} label="Customer App" active={currentPath === '/ops-intelligence' && location.search.includes('tab=customer-app')} collapsed={isCollapsed} />
            <P pageSlug="ops-intelligence" to="/ops-intelligence?tab=guest" icon={<Globe className="h-4 w-4" />} label="Guest Booking" active={currentPath === '/ops-intelligence' && location.search.includes('tab=guest')} collapsed={isCollapsed} />
            <P pageSlug="ops-intelligence" to="/ops-intelligence?tab=corporate" icon={<Building2 className="h-4 w-4" />} label="Corporate" active={currentPath === '/ops-intelligence' && location.search.includes('tab=corporate')} collapsed={isCollapsed} />
            <P pageSlug="ops-intelligence" to="/ops-intelligence?tab=money" icon={<CreditCard className="h-4 w-4" />} label="Money Integrity" active={currentPath === '/ops-intelligence' && location.search.includes('tab=money')} collapsed={isCollapsed} />
            <P pageSlug="ops-intelligence" to="/ops-intelligence?tab=app-performance" icon={<Gauge className="h-4 w-4" />} label="App Performance" active={currentPath === '/ops-intelligence' && location.search.includes('tab=app-performance')} collapsed={isCollapsed} />
            <P pageSlug="ops-intelligence" to="/ops-intelligence?tab=integration" icon={<FileText className="h-4 w-4" />} label="Integration Guide" active={currentPath === '/ops-intelligence' && location.search.includes('tab=integration')} collapsed={isCollapsed} />
          </Section>

          {/* SETTINGS */}
          <Section label="Settings" slugs={['general-settings','integrations','payment-providers','webhooks','roles','user-directory','notifications','alert-sounds']}>
            <P pageSlug="general-settings" to="/general-settings" icon={<Palette className="h-4 w-4" />} label="General & Branding" active={currentPath === '/general-settings'} collapsed={isCollapsed} />
            <P pageSlug="integrations" to="/integrations" icon={<Plug className="h-4 w-4" />} label="Integrations & API" active={currentPath === '/integrations'} collapsed={isCollapsed} />
            <P pageSlug="payment-providers" to="/payment-providers" icon={<CreditCard className="h-4 w-4" />} label="Payment Providers" active={currentPath === '/payment-providers'} collapsed={isCollapsed} />
            <P pageSlug="webhooks" to="/webhooks" icon={<Webhook className="h-4 w-4" />} label="Webhooks" active={currentPath === '/webhooks'} collapsed={isCollapsed} />
            <P pageSlug="roles" to="/roles" icon={<Shield className="h-4 w-4" />} label="Roles & Permissions" active={currentPath === '/roles'} collapsed={isCollapsed} />
            <P pageSlug="user-directory" to="/user-directory" icon={<Contact className="h-4 w-4" />} label="User Directory" active={currentPath === '/user-directory'} collapsed={isCollapsed} />
            <P pageSlug="notifications" to="/notifications" icon={<Bell className="h-4 w-4" />} label="Notifications & Alerts" active={currentPath === '/notifications'} collapsed={isCollapsed} />
            <P pageSlug="alert-sounds" to="/alert-sounds" icon={<Volume2 className="h-4 w-4" />} label="Alert Sounds" active={currentPath === '/alert-sounds'} collapsed={isCollapsed} />
          </Section>

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
                <p className="font-medium">{staffProfile?.full_name || user?.user_metadata?.display_name || user?.email || 'Admin'}</p>
                <p className="text-xs text-muted-foreground">
                  {staffProfile ? `${staffProfile.staff_role_id} · ${staffProfile.role.replace(/_/g, ' ')}` : 'Administrator'}
                </p>
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
                  {staffProfile?.full_name || user?.user_metadata?.display_name || user?.email || 'Admin'}
                </p>
                <p className="text-xs text-[hsl(var(--sidebar-muted))]">
                  {staffProfile ? `${staffProfile.staff_role_id} · ${staffProfile.role.replace(/_/g, ' ')}` : 'Administrator'}
                </p>
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
