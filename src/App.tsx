import { Suspense, lazy, type ComponentType, type LazyExoticComponent } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OfflineDetector } from "@/components/OfflineDetector";
import { GlobalErrorBoundary } from "@/components/GlobalErrorBoundary";
import { QueryClientProvider } from "@tanstack/react-query";
import { createAppQueryClient } from "@/lib/queryConfig";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "@/hooks/useAuth";
import { StaffProfileProvider } from "@/hooks/useStaffProfile";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AdminShell } from "@/components/layout/AdminShell";
import { AdminTelemetryProvider } from "@/lib/telemetry/adminBootstrap";
import { AdminTabActivityHost, AdminSupportPresenceHost } from "@/hooks/useAdminTabActivity";
import { Loader2 } from "lucide-react";

/** Eager auth entry — keep login bundle small and fast. */
import Auth from "./pages/Auth";
import AuthReset from "./pages/AuthReset";
import RevolutBusinessOAuthCallback from "./pages/auth/RevolutBusinessOAuthCallback";

const queryClient = createAppQueryClient();

function lazyPage(
  loader: () => Promise<{ default: ComponentType<object> }>,
): LazyExoticComponent<ComponentType<object>> {
  return lazy(loader);
}

function RouteFallback() {
  return (
    <div className="flex min-h-[40vh] w-full items-center justify-center p-8" role="status" aria-label="Loading page">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

const Index = lazyPage(() => import("./pages/Index"));
const NotFound = lazyPage(() => import("./pages/NotFound"));
const Dashboard = lazyPage(() => import("./pages/Dashboard"));
const Dispatch = lazyPage(() => import("./pages/Dispatch"));
const ActiveTrips = lazyPage(() => import("./pages/ActiveTrips"));
const ScheduledRides = lazyPage(() => import("./pages/ScheduledRides"));
const MissedCancelled = lazyPage(() => import("./pages/MissedCancelled"));
const ManualTrip = lazyPage(() => import("./pages/ManualTrip"));
const TripHistory = lazyPage(() => import("./pages/TripHistory"));
const Drivers = lazyPage(() => import("./pages/Drivers"));
const Vehicles = lazyPage(() => import("./pages/Vehicles"));
const FleetTracking = lazyPage(() => import("./pages/FleetTracking"));
const Documents = lazyPage(() => import("./pages/Documents"));
const DocumentManagement = lazyPage(() => import("./pages/DocumentManagement"));
const Regions = lazyPage(() => import("./pages/Regions"));
const Services = lazyPage(() => import("./pages/Services"));
const VehicleTypes = lazyPage(() => import("./pages/VehicleTypes"));
const CustomZones = lazyPage(() => import("./pages/CustomZones"));
const AutoDispatchRules = lazyPage(() => import("./pages/AutoDispatchRules"));
const ServiceAreaPricing = lazyPage(() => import("./pages/ServiceAreaPricing"));
const ZonePricing = lazyPage(() => import("./pages/ZonePricing"));
const CorporateFares = lazyPage(() => import("./pages/CorporateFares"));
const FareSimulator = lazyPage(() => import("./pages/FareSimulator"));
const PromoCodes = lazyPage(() => import("./pages/PromoCodes"));
const Offers = lazyPage(() => import("./pages/Offers"));
const CorporateAccounts = lazyPage(() => import("./pages/CorporateAccounts"));
const CorporateBilling = lazyPage(() => import("./pages/CorporateBilling"));
const CorporateReports = lazyPage(() => import("./pages/CorporateReports"));
const CorporateSettings = lazyPage(() => import("./pages/CorporateSettings"));
const AccountRequests = lazyPage(() => import("./pages/AccountRequests"));
const Riders = lazyPage(() => import("./pages/Riders"));
const PendingCustomerSignups = lazyPage(() => import("./pages/PendingCustomerSignups"));
const RiderFeedback = lazyPage(() => import("./pages/RiderFeedback"));
const AccountSuspension = lazyPage(() => import("./pages/AccountSuspension"));
const ComplaintsDashboard = lazyPage(() => import("./pages/ComplaintsDashboard"));
const Tickets = lazyPage(() => import("./pages/Tickets"));
const SupportCategories = lazyPage(() => import("./pages/SupportCategories"));
const FinancialReconciliation = lazyPage(() => import("./pages/FinancialReconciliation"));
const PaymentSessions = lazyPage(() => import("./pages/PaymentSessions"));
const PayoutLedger = lazyPage(() => import("./pages/PayoutLedger"));
const LegacyDriversPayoutsRedirect = lazyPage(() => import("./pages/LegacyDriversPayoutsRedirect"));
const DriverWalletLedger = lazyPage(() => import("./pages/DriverWalletLedger"));
const CommissionWallet = lazyPage(() => import("./pages/CommissionWallet"));
const AnnualTaxiReport = lazyPage(() => import("./pages/AnnualTaxiReport"));
const OnecabRevenueProfitReport = lazyPage(() => import("./pages/OnecabRevenueProfitReport"));
const Disputes = lazyPage(() => import("./pages/Disputes"));
const DisputeSettings = lazyPage(() => import("./pages/DisputeSettings"));
const Invoices = lazyPage(() => import("./pages/Invoices"));
const InvoiceTemplates = lazyPage(() => import("./pages/InvoiceTemplates"));
const StatementRuns = lazyPage(() => import("./pages/StatementRuns"));
const GeneralSettings = lazyPage(() => import("./pages/GeneralSettings"));
const Integrations = lazyPage(() => import("./pages/Integrations"));
const PaymentProviders = lazyPage(() => import("./pages/PaymentProviders"));
const RolesPermissions = lazyPage(() => import("./pages/RolesPermissions"));
const Notifications = lazyPage(() => import("./pages/Notifications"));
const AdminProfile = lazyPage(() => import("./pages/AdminProfile"));
const ManageContent = lazyPage(() => import("./pages/ManageContent"));
const HelpCentre = lazyPage(() => import("./pages/HelpCentre"));
const DriverSpecialOffers = lazyPage(() => import("./pages/DriverSpecialOffers"));
const CustomerSpecialOffers = lazyPage(() => import("./pages/CustomerSpecialOffers"));
const LiveChat = lazyPage(() => import("./pages/LiveChat"));
const OnecabDocuments = lazyPage(() => import("./pages/OnecabDocuments"));
const AlertSounds = lazyPage(() => import("./pages/AlertSounds"));
const UserDirectory = lazyPage(() => import("./pages/UserDirectory"));
const DispatchMetrics = lazyPage(() => import("./pages/DispatchMetrics"));
const DriverDemandZones = lazyPage(() => import("./pages/DriverDemandZones"));
const StaffWorkPatterns = lazyPage(() => import("./pages/StaffWorkPatterns"));
const LostProperty = lazyPage(() => import("./pages/LostProperty"));
const LostPropertyDetail = lazyPage(() => import("./pages/LostPropertyDetail"));

const App = () => (
  <GlobalErrorBoundary>
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <StaffProfileProvider>
      <TooltipProvider>
        <OfflineDetector />
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <Suspense fallback={<RouteFallback />}>
          <AdminTabActivityHost />
          <AdminSupportPresenceHost />
          <AdminTelemetryProvider />
          <Routes>
            {/* Public Auth Routes */}
            <Route path="/auth" element={<Auth />} />
            <Route path="/auth/reset" element={<AuthReset />} />
            <Route path="/auth/revolut/callback" element={<RevolutBusinessOAuthCallback />} />
            <Route path="/login" element={<Navigate to="/auth" replace />} />
            
            
            {/* Protected Admin Routes - wrapped in persistent shell */}
            <Route element={<ProtectedRoute><AdminShell /></ProtectedRoute>}>
              <Route index element={<Index />} />
              <Route path="dashboard" element={<Dashboard />} />
              
              {/* Operations & Dispatch */}
              <Route path="fleet-tracking" element={<FleetTracking />} />
              <Route path="active-trips" element={<ActiveTrips />} />
              <Route path="auto-dispatch" element={<AutoDispatchRules />} />
              <Route path="scheduled-rides" element={<ScheduledRides />} />
              <Route path="missed-cancelled" element={<MissedCancelled />} />
              <Route path="trip-history" element={<TripHistory />} />
              <Route path="manual-trip" element={<ManualTrip />} />
              <Route path="dispatch" element={<Dispatch />} />
              <Route path="dispatch-metrics" element={<DispatchMetrics />} />
              <Route path="driver-demand-zones" element={<DriverDemandZones />} />
              <Route path="staff-work-patterns" element={<StaffWorkPatterns />} />
              
              {/* Service Areas */}
              <Route path="regions" element={<Regions />} />
              <Route path="services" element={<Services />} />
              <Route path="service-area-pricing" element={<ServiceAreaPricing />} />
              <Route path="custom-zones" element={<CustomZones />} />
              <Route path="zone-pricing" element={<ZonePricing />} />
              <Route path="vehicle-types" element={<VehicleTypes />} />
              <Route path="documents" element={<Documents />} />
              <Route path="document-management" element={<DocumentManagement />} />
              
              {/* Fleet Management */}
              <Route path="drivers" element={<Drivers />} />
              <Route path="vehicles" element={<Vehicles />} />
              <Route path="riders" element={<Riders />} />
              <Route path="pending-customer-signups" element={<PendingCustomerSignups />} />

              {/* Pricing & Fares */}
              <Route path="promo-codes" element={<PromoCodes />} />
              <Route path="offers" element={<Offers />} />
              

              
              
              
              <Route path="fare-simulator" element={<FareSimulator />} />
              
              
              {/* Corporate */}
              <Route path="corporate-accounts" element={<CorporateAccounts />} />
              <Route path="account-requests" element={<AccountRequests />} />
              <Route path="corporate-billing" element={<CorporateBilling />} />
              <Route path="corporate-reports" element={<CorporateReports />} />
               <Route path="corporate-fares" element={<CorporateFares />} />
               <Route path="corporate-settings" element={<CorporateSettings />} />
              
              {/* Users & Support */}
              <Route path="rider-feedback" element={<RiderFeedback />} />
              <Route path="suspensions" element={<AccountSuspension />} />
              <Route path="complaints" element={<ComplaintsDashboard />} />
              <Route path="tickets" element={<Tickets />} />
              <Route path="live-chat" element={<LiveChat />} />
              <Route path="categories" element={<SupportCategories />} />
              <Route path="lost-property" element={<LostProperty />} />
              <Route path="lost-property/:caseId" element={<LostPropertyDetail />} />
              
              {/* Payments & Transactions (SSOT) */}
              <Route path="payments" element={<Navigate to="/payment-sessions" replace />} />
              <Route path="payment-sessions" element={<PaymentSessions />} />
              <Route path="financial-reconciliation" element={<FinancialReconciliation />} />
              <Route path="drivers-and-payouts" element={<LegacyDriversPayoutsRedirect />} />
              <Route path="driver-wallet" element={<Navigate to="/driver-wallet-ledger" replace />} />
              <Route path="admin-settlements" element={<Navigate to="/financial-reconciliation" replace />} />
              <Route path="finance-ledger-transactions" element={<Navigate to="/driver-wallet-ledger?tab=ledger" replace />} />
              <Route path="driver-wallet-ledger" element={<DriverWalletLedger />} />
              <Route path="commission-wallet" element={<CommissionWallet />} />
              <Route path="payout-ledger" element={<PayoutLedger />} />
              <Route path="payout-batches" element={<Navigate to="/payout-ledger?tab=batches" replace />} />
              <Route path="connect-payout-lockdown" element={<Navigate to="/payout-ledger?tab=processing" replace />} />
              <Route path="disputes" element={<Disputes />} />
              <Route path="dispute-settings" element={<DisputeSettings />} />
              <Route path="invoices" element={<Invoices />} />
              <Route path="invoice-templates" element={<InvoiceTemplates />} />
              <Route path="statement-runs" element={<StatementRuns />} />
              <Route path="annual-taxi-report" element={<AnnualTaxiReport />} />
              <Route path="onecab-revenue-profit" element={<OnecabRevenueProfitReport />} />
              
              {/* ONECAB Documents */}
              <Route path="onecab-documents" element={<OnecabDocuments />} />

              {/* Content & Legal */}
              <Route path="content" element={<ManageContent />} />
              <Route path="help-centre" element={<HelpCentre />} />
              <Route path="driver-special-offers" element={<DriverSpecialOffers />} />
              <Route path="customer-special-offers" element={<CustomerSpecialOffers />} />
              
              {/* Settings */}
              <Route path="general-settings" element={<GeneralSettings />} />
              <Route path="integrations" element={<Integrations />} />
              <Route path="payment-providers" element={<PaymentProviders />} />
              
              <Route path="roles" element={<RolesPermissions />} />
              <Route path="notifications" element={<Notifications />} />
              <Route path="alert-sounds" element={<AlertSounds />} />
              <Route path="user-directory" element={<UserDirectory />} />
              
              <Route path="profile" element={<AdminProfile />} />
            </Route>
            
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
        </BrowserRouter>
      </TooltipProvider>
      </StaffProfileProvider>
    </AuthProvider>
  </QueryClientProvider>
  </GlobalErrorBoundary>
);

export default App;
