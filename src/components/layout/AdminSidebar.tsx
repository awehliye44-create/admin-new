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
  Gift,
} from 'lucide-react';
import { useState, memo, useCallback, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  ADMIN_SIDEBAR_COLLAPSED_KEY,
  ADMIN_SIDEBAR_COLLAPSED_PX,
  ADMIN_SIDEBAR_EXPANDED_PX,
} from '@/lib/adminSidebarLayout';

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  badge?: number;
  badgeColor?: 'primary' | 'destructive';
  collapsed?: boolean;
}

/**
 * Stable nav row — fixed height, reserved active border + badge slot.
 * Must not change size when becoming active (layout jump).
 * Lower sections (Driver Statements → Settings) especially need scroll lock on focus.
 */
const NavItem = memo(function NavItem({
  to,
  icon,
  label,
  active,
  badge,
  badgeColor = 'primary',
  collapsed,
}: NavItemProps) {
  const badgeClass = badgeColor === 'destructive'
    ? 'bg-destructive text-destructive-foreground text-xs h-5 min-w-5 flex items-center justify-center'
    : 'bg-primary text-primary-foreground text-xs h-5 min-w-5 flex items-center justify-center';
  const showBadge = badge !== undefined && badge > 0;

  const preserveNavScroll = (el: HTMLElement) => {
    const nav = el.closest('.admin-sidebar-nav') as HTMLElement | null;
    if (!nav) return;
    const y = nav.scrollTop;
    requestAnimationFrame(() => {
      nav.scrollTop = y;
    });
  };

  const content = (
    <Link
      to={to}
      data-active={active ? 'true' : 'false'}
      onClick={(e) => preserveNavScroll(e.currentTarget)}
      onFocus={(e) => preserveNavScroll(e.currentTarget)}
      className={cn(
        'admin-sidebar-item flex h-[44px] max-h-[44px] min-h-[44px] items-center justify-between rounded-lg px-3 text-sm font-medium transition-colors',
        'border-l-[3px] border-l-transparent',
        active
          ? 'border-l-primary bg-sidebar-accent text-primary'
          : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        collapsed && 'justify-center px-2',
      )}
    >
      <div className={cn('flex min-w-0 flex-1 items-center gap-3', collapsed && 'flex-none gap-0')}>
        <span className="admin-sidebar-icon">{icon}</span>
        {!collapsed && <span className="truncate leading-none">{label}</span>}
      </div>
      {!collapsed && (
        <span className="admin-sidebar-badge-slot ml-2" aria-hidden={!showBadge}>
          {showBadge ? (
            <Badge variant="secondary" className={badgeClass}>
              {badge > 99 ? '99+' : badge}
            </Badge>
          ) : null}
        </span>
      )}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="right" className="flex items-center gap-2">
          {label}
          {showBadge && (
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
    return (
      <div className="admin-sidebar-section mx-2 my-0 flex items-center" aria-hidden>
        <div className="h-px w-full bg-sidebar-border" />
      </div>
    );
  }

  return (
    <div
      className="admin-sidebar-section flex h-[44px] max-h-[44px] min-h-[44px] items-center px-3 text-xs font-semibold uppercase tracking-wider text-[hsl(var(--sidebar-muted))] border-l-[3px] border-l-transparent"
      data-admin-sidebar-section={label}
    >
      <span className="truncate leading-none">{label}</span>
    </div>
  );
}

/** Stable module-level helpers — never redefine inside AdminSidebar (remount jump). */
function PermissionNavItem({
  pageSlug,
  canAccess,
  ...props
}: NavItemProps & { pageSlug: string; canAccess: (slug: string) => boolean }) {
  if (!canAccess(pageSlug)) return null;
  return <NavItem {...props} />;
}

function PermissionSection({
  label,
  slugs,
  canAccess,
  collapsed,
  children,
}: {
  label: string;
  slugs: string[];
  canAccess: (slug: string) => boolean;
  collapsed?: boolean;
  children: ReactNode;
}) {
  if (!slugs.some((s) => canAccess(s))) return null;
  return (
    <div>
      <NavSection label={label} collapsed={collapsed} />
      <div className="space-y-1">{children}</div>
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
    const stored = localStorage.getItem(ADMIN_SIDEBAR_COLLAPSED_KEY);
    return stored === 'true';
  });

  const toggleCollapsed = useCallback(() => {
    setIsCollapsed((prev) => {
      const newValue = !prev;
      localStorage.setItem(ADMIN_SIDEBAR_COLLAPSED_KEY, String(newValue));
      return newValue;
    });
  }, []);

  const widthPx = isCollapsed ? ADMIN_SIDEBAR_COLLAPSED_PX : ADMIN_SIDEBAR_EXPANDED_PX;

  return (
    <aside
      data-admin-sidebar
      data-collapsed={isCollapsed ? 'true' : 'false'}
      className={cn(
        'admin-sidebar flex h-screen flex-col bg-sidebar border-r border-sidebar-border shrink-0',
        'transition-[width] duration-200 ease-in-out',
      )}
      style={{
        width: widthPx,
        minWidth: widthPx,
        maxWidth: widthPx,
        ['--admin-sidebar-width' as string]: `${widthPx}px`,
      }}
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

      {/* Navigation — native overflow keeps scroll across route changes; stable gutter avoids width jump */}
      <nav
        className="admin-sidebar-nav flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 py-4 scrollbar-gutter-stable"
        aria-label="Admin navigation"
      >
        <div className="space-y-4">
          {/* DASHBOARD */}
          <PermissionSection canAccess={canAccessPage} collapsed={isCollapsed} label="Dashboard" slugs={['dashboard']}>
            <PermissionNavItem canAccess={canAccessPage} pageSlug="dashboard" to="/dashboard" icon={<LayoutDashboard className="h-4 w-4" />} label="Main Dashboard" active={currentPath === '/dashboard'} collapsed={isCollapsed} />
          </PermissionSection>

          {/* OPERATIONS & DISPATCH */}
          <PermissionSection canAccess={canAccessPage} collapsed={isCollapsed}
            label="Operations & Dispatch"
            slugs={['fleet-tracking','active-trips','auto-dispatch','scheduled-rides','missed-cancelled','trip-history','manual-trip','dispatch-metrics','driver-demand-zones','staff-work-patterns']}
          >
            <PermissionNavItem canAccess={canAccessPage} pageSlug="fleet-tracking" to="/fleet-tracking" icon={<Send className="h-4 w-4" />} label="Live Fleet Tracking" active={currentPath === '/fleet-tracking'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="active-trips" to="/active-trips" icon={<Radio className="h-4 w-4" />} label="Active Trips (Real-time)" active={currentPath === '/active-trips'} badge={counts.activeTrips > 0 ? counts.activeTrips : undefined} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="auto-dispatch" to="/auto-dispatch" icon={<Target className="h-4 w-4" />} label="Auto-Dispatch Rules" active={currentPath === '/auto-dispatch'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="scheduled-rides" to="/scheduled-rides" icon={<Calendar className="h-4 w-4" />} label="Scheduled Rides" active={currentPath === '/scheduled-rides'} badge={counts.scheduledRides > 0 ? counts.scheduledRides : undefined} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="missed-cancelled" to="/missed-cancelled" icon={<XCircle className="h-4 w-4" />} label="Missed & Canceled" active={currentPath === '/missed-cancelled'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="trip-history" to="/trip-history" icon={<History className="h-4 w-4" />} label="Trip History" active={currentPath === '/trip-history'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="manual-trip" to="/manual-trip" icon={<Plus className="h-4 w-4" />} label="Manual Trip Creation" active={currentPath === '/manual-trip'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="dispatch-metrics" to="/dispatch-metrics" icon={<Activity className="h-4 w-4" />} label="Dispatch Metrics" active={currentPath === '/dispatch-metrics'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="driver-demand-zones" to="/driver-demand-zones" icon={<Flame className="h-4 w-4" />} label="Driver Demand Zones" active={currentPath === '/driver-demand-zones'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="staff-work-patterns" to="/staff-work-patterns" icon={<Calendar className="h-4 w-4" />} label="Staff Work Patterns" active={currentPath === '/staff-work-patterns'} collapsed={isCollapsed} />
          </PermissionSection>

          {/* FLEET MANAGEMENT */}
          <PermissionSection canAccess={canAccessPage} collapsed={isCollapsed} label="Fleet Management" slugs={['drivers','vehicles','vehicle-types','documents','document-management']}>
            <PermissionNavItem canAccess={canAccessPage} pageSlug="drivers" to="/drivers" icon={<UserCircle className="h-4 w-4" />} label="Driver List" active={currentPath === '/drivers'} badge={counts.pendingDrivers > 0 ? counts.pendingDrivers : undefined} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="vehicles" to="/vehicles" icon={<Car className="h-4 w-4" />} label="Vehicle List" active={currentPath === '/vehicles'} badge={counts.pendingVehicleChanges > 0 ? counts.pendingVehicleChanges : undefined} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="vehicle-types" to="/vehicle-types" icon={<CarTaxiFront className="h-4 w-4" />} label="Vehicle Types" active={currentPath === '/vehicle-types'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="documents" to="/documents" icon={<FolderOpen className="h-4 w-4" />} label="Document Review" active={currentPath === '/documents'} badge={counts.pendingDocuments > 0 ? counts.pendingDocuments : undefined} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="document-management" to="/document-management" icon={<Settings2 className="h-4 w-4" />} label="Document Management" active={currentPath === '/document-management'} collapsed={isCollapsed} />
          </PermissionSection>


          {/* SERVICE AREAS */}
          <PermissionSection canAccess={canAccessPage} collapsed={isCollapsed} label="Service Areas" slugs={['regions','services']}>
            <PermissionNavItem canAccess={canAccessPage} pageSlug="regions" to="/regions" icon={<MapPin className="h-4 w-4" />} label="Regions" active={currentPath === '/regions'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="services" to="/services" icon={<Map className="h-4 w-4" />} label="Services" active={currentPath === '/services'} collapsed={isCollapsed} />
          </PermissionSection>

          {/* PRICING & FARES */}
          <PermissionSection canAccess={canAccessPage} collapsed={isCollapsed} label="Pricing & Fares" slugs={['promo-codes','offers','custom-zones','zone-pricing','fare-simulator']}>
            <PermissionNavItem canAccess={canAccessPage} pageSlug="promo-codes" to="/promo-codes" icon={<Tag className="h-4 w-4" />} label="Promo Codes" active={currentPath === '/promo-codes'} badge={counts.activePromoCodes > 0 ? counts.activePromoCodes : undefined} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="offers" to="/offers" icon={<Sparkles className="h-4 w-4" />} label="Customer Offers" active={currentPath === '/offers'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="custom-zones" to="/custom-zones" icon={<CircleDollarSign className="h-4 w-4" />} label="Custom Zones" active={currentPath === '/custom-zones'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="zone-pricing" to="/zone-pricing" icon={<Target className="h-4 w-4" />} label="Geofence & Zone Pricing" active={currentPath === '/zone-pricing'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="fare-simulator" to="/fare-simulator" icon={<Calculator className="h-4 w-4" />} label="Fare Simulator" active={currentPath === '/fare-simulator'} collapsed={isCollapsed} />
          </PermissionSection>

          {/* CORPORATE */}
          <PermissionSection canAccess={canAccessPage} collapsed={isCollapsed} label="Corporate" slugs={['corporate-accounts','account-requests','corporate-billing','corporate-reports','corporate-fares','corporate-settings']}>
            <PermissionNavItem canAccess={canAccessPage} pageSlug="corporate-accounts" to="/corporate-accounts" icon={<Briefcase className="h-4 w-4" />} label="Corporate Accounts" active={currentPath === '/corporate-accounts'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="account-requests" to="/account-requests" icon={<FileText className="h-4 w-4" />} label="Account Requests" active={currentPath === '/account-requests'} badge={counts.pendingAccountRequests} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="corporate-billing" to="/corporate-billing" icon={<CreditCard className="h-4 w-4" />} label="Corporate Billing" active={currentPath === '/corporate-billing'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="corporate-reports" to="/corporate-reports" icon={<BarChart3 className="h-4 w-4" />} label="Corporate Reports" active={currentPath === '/corporate-reports'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="corporate-fares" to="/corporate-fares" icon={<Building2 className="h-4 w-4" />} label="Corporate Fare Rules" active={currentPath === '/corporate-fares'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="corporate-settings" to="/corporate-settings" icon={<Settings className="h-4 w-4" />} label="Corporate Settings" active={currentPath === '/corporate-settings'} collapsed={isCollapsed} />
          </PermissionSection>

          {/* RIDER MANAGEMENT */}
          <PermissionSection canAccess={canAccessPage} collapsed={isCollapsed} label="Rider Management" slugs={['riders','pending-customer-signups','rider-feedback']}>
            <PermissionNavItem canAccess={canAccessPage} pageSlug="riders" to="/riders" icon={<Users className="h-4 w-4" />} label="Rider List" active={currentPath === '/riders'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="pending-customer-signups" to="/pending-customer-signups" icon={<UserPlus className="h-4 w-4" />} label="Pending Signups" active={currentPath === '/pending-customer-signups'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="rider-feedback" to="/rider-feedback" icon={<MessageSquare className="h-4 w-4" />} label="Rider Feedback" active={currentPath === '/rider-feedback'} collapsed={isCollapsed} />
          </PermissionSection>

          {/* SUPPORT */}
          <PermissionSection canAccess={canAccessPage} collapsed={isCollapsed} label="Support" slugs={['suspensions','complaints','live-chat','tickets','lost-property','categories']}>
            <PermissionNavItem canAccess={canAccessPage} pageSlug="suspensions" to="/suspensions" icon={<UserX className="h-4 w-4" />} label="Account Suspension" active={currentPath === '/suspensions'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="complaints" to="/complaints" icon={<AlertTriangle className="h-4 w-4" />} label="Complaints Dashboard" active={currentPath === '/complaints'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="live-chat" to="/live-chat" icon={<MessageSquare className="h-4 w-4" />} label="Live Chat" active={currentPath === '/live-chat'} badge={chatUnread > 0 ? chatUnread : undefined} badgeColor="destructive" collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="tickets" to="/tickets" icon={<Ticket className="h-4 w-4" />} label="Tickets" active={currentPath === '/tickets'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="lost-property" to="/lost-property" icon={<PackageSearch className="h-4 w-4" />} label="Lost Property" active={currentPath === '/lost-property' || currentPath.startsWith('/lost-property/')} badge={lpUnread > 0 ? lpUnread : undefined} badgeColor="destructive" collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="categories" to="/categories" icon={<Grid3X3 className="h-4 w-4" />} label="Support Categories" active={currentPath === '/categories'} collapsed={isCollapsed} />
          </PermissionSection>

          {/* PAYMENTS & TRANSACTIONS (SSOT) */}
          <PermissionSection canAccess={canAccessPage} collapsed={isCollapsed} label="Payments & Transactions" slugs={['payment-sessions','financial-reconciliation','driver-wallet-ledger','commission-wallet','payout-ledger']}>
            <PermissionNavItem canAccess={canAccessPage} pageSlug="payment-sessions" to="/payment-sessions" icon={<CreditCard className="h-4 w-4" />} label="Payment Sessions (SSOT)" active={currentPath === '/payment-sessions'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="financial-reconciliation" to="/financial-reconciliation" icon={<Calculator className="h-4 w-4" />} label="Financial Reconciliation (SSOT)" active={currentPath === '/financial-reconciliation'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="driver-wallet-ledger" to="/driver-wallet-ledger" icon={<Wallet className="h-4 w-4" />} label="Driver Wallet Ledger (SSOT)" active={currentPath === '/driver-wallet-ledger'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="commission-wallet" to="/commission-wallet" icon={<CircleDollarSign className="h-4 w-4" />} label="Commission Wallet (Driver-Collected)" active={currentPath === '/commission-wallet'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="payout-ledger" to="/payout-ledger" icon={<Coins className="h-4 w-4" />} label="Payout Ledger (SSOT)" active={currentPath === '/payout-ledger'} collapsed={isCollapsed} />
          </PermissionSection>

          {/* DRIVER STATEMENTS / INVOICES */}
          <PermissionSection canAccess={canAccessPage} collapsed={isCollapsed} label="Driver Statements" slugs={['invoices','statement-runs','invoice-templates','annual-taxi-report']}>
            <PermissionNavItem canAccess={canAccessPage} pageSlug="invoices" to="/invoices" icon={<FileText className="h-4 w-4" />} label="Driver Invoices" active={currentPath === '/invoices'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="statement-runs" to="/statement-runs" icon={<Calendar className="h-4 w-4" />} label="Statement Schedule" active={currentPath === '/statement-runs'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="invoice-templates" to="/invoice-templates" icon={<FileEdit className="h-4 w-4" />} label="Invoice Templates" active={currentPath === '/invoice-templates'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="annual-taxi-report" to="/annual-taxi-report" icon={<FileText className="h-4 w-4" />} label="Annual Driver Statement" active={currentPath === '/annual-taxi-report'} collapsed={isCollapsed} />
          </PermissionSection>

          {/* REPORTS */}
          <PermissionSection canAccess={canAccessPage} collapsed={isCollapsed} label="Reports" slugs={['onecab-revenue-profit']}>
            <PermissionNavItem canAccess={canAccessPage} pageSlug="onecab-revenue-profit" to="/onecab-revenue-profit" icon={<BarChart3 className="h-4 w-4" />} label="ONECAB Revenue & Profit" active={currentPath === '/onecab-revenue-profit'} collapsed={isCollapsed} />
          </PermissionSection>

          {/* ONECAB DOCUMENTS */}
          <PermissionSection canAccess={canAccessPage} collapsed={isCollapsed} label="ONECAB Documents" slugs={['onecab-documents']}>
            <PermissionNavItem canAccess={canAccessPage} pageSlug="onecab-documents" to="/onecab-documents" icon={<ShieldCheck className="h-4 w-4" />} label="Compliance Center" active={currentPath === '/onecab-documents'} collapsed={isCollapsed} />
          </PermissionSection>

          {/* CONTENT & LEGAL */}
          <PermissionSection canAccess={canAccessPage} collapsed={isCollapsed} label="Content & Legal" slugs={['content', 'help-centre', 'customer-special-offers', 'driver-special-offers']}>
            <PermissionNavItem canAccess={canAccessPage} pageSlug="content" to="/content" icon={<FileEdit className="h-4 w-4" />} label="Manage Content" active={currentPath === '/content'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="help-centre" to="/help-centre" icon={<FileEdit className="h-4 w-4" />} label="Help Centre" active={currentPath === '/help-centre'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="customer-special-offers" to="/customer-special-offers" icon={<Gift className="h-4 w-4" />} label="Customer Special Offers" active={currentPath === '/customer-special-offers'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="driver-special-offers" to="/driver-special-offers" icon={<FileEdit className="h-4 w-4" />} label="Driver Special Offers" active={currentPath === '/driver-special-offers'} collapsed={isCollapsed} />
          </PermissionSection>


          {/* SETTINGS */}
          <PermissionSection canAccess={canAccessPage} collapsed={isCollapsed} label="Settings" slugs={['general-settings','payment-providers','roles','user-directory','notifications','alert-sounds']}>
            <PermissionNavItem canAccess={canAccessPage} pageSlug="general-settings" to="/general-settings" icon={<Palette className="h-4 w-4" />} label="General & Branding" active={currentPath === '/general-settings'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="payment-providers" to="/payment-providers" icon={<CreditCard className="h-4 w-4" />} label="Payment Providers" active={currentPath === '/payment-providers' || currentPath === '/integrations'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="roles" to="/roles" icon={<Shield className="h-4 w-4" />} label="Roles & Permissions" active={currentPath === '/roles'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="user-directory" to="/user-directory" icon={<Contact className="h-4 w-4" />} label="User Directory" active={currentPath === '/user-directory'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="notifications" to="/notifications" icon={<Bell className="h-4 w-4" />} label="Notifications & Alerts" active={currentPath === '/notifications'} collapsed={isCollapsed} />
            <PermissionNavItem canAccess={canAccessPage} pageSlug="alert-sounds" to="/alert-sounds" icon={<Volume2 className="h-4 w-4" />} label="Alert Sounds" active={currentPath === '/alert-sounds'} collapsed={isCollapsed} />
          </PermissionSection>

        </div>
      </nav>

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
