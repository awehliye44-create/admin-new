import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Index from "./pages/Index";
import Auth from "./pages/Auth";
import AuthReset from "./pages/AuthReset";
import NotFound from "./pages/NotFound";
import Dashboard from "./pages/Dashboard";
import Dispatch from "./pages/Dispatch";
import ActiveTrips from "./pages/ActiveTrips";
import ScheduledRides from "./pages/ScheduledRides";
import MissedCancelled from "./pages/MissedCancelled";
import ManualTrip from "./pages/ManualTrip";
import TripHistory from "./pages/TripHistory";
import Drivers from "./pages/Drivers";
import Vehicles from "./pages/Vehicles";
import FleetTracking from "./pages/FleetTracking";
import Documents from "./pages/Documents";

import Regions from "./pages/Regions";
import Services from "./pages/Services";
import VehicleTypes from "./pages/VehicleTypes";
import CustomZones from "./pages/CustomZones";
import AutoDispatchRules from "./pages/AutoDispatchRules";
import ServiceAreaPricing from "./pages/ServiceAreaPricing";
import ZonePricing from "./pages/ZonePricing";

import CorporateFares from "./pages/CorporateFares";
import FareSimulator from "./pages/FareSimulator";

import PromoCodes from "./pages/PromoCodes";
import CorporateAccounts from "./pages/CorporateAccounts";
import CorporateBilling from "./pages/CorporateBilling";
import CorporateReports from "./pages/CorporateReports";
import CorporateSettings from "./pages/CorporateSettings";
import AccountRequests from "./pages/AccountRequests";
import Riders from "./pages/Riders";
import RiderFeedback from "./pages/RiderFeedback";
import AccountSuspension from "./pages/AccountSuspension";
import ComplaintsDashboard from "./pages/ComplaintsDashboard";
import Tickets from "./pages/Tickets";
import SupportCategories from "./pages/SupportCategories";
import AdminPayments from "./pages/AdminPayments";
import AdminDriverSettlements from "./pages/AdminDriverSettlements";
import DriverWallet from "./pages/DriverWallet";
import AdminPayoutBatches from "./pages/AdminPayoutBatches";
import Disputes from "./pages/Disputes";
import DisputeSettings from "./pages/DisputeSettings";
import GeneralSettings from "./pages/GeneralSettings";
import Integrations from "./pages/Integrations";
import Webhooks from "./pages/Webhooks";
import SystemRequirements from "./pages/SystemRequirements";
import RolesPermissions from "./pages/RolesPermissions";
import Notifications from "./pages/Notifications";
import AdminProfile from "./pages/AdminProfile";
import { AuthProvider } from "@/hooks/useAuth";
import { StaffProfileProvider } from "@/hooks/useStaffProfile";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AdminShell } from "@/components/layout/AdminShell";

import { Airports } from "./pages/PlaceholderPage";
import ManageContent from "./pages/ManageContent";
import LiveChat from "./pages/LiveChat";
import OnecabDocuments from "./pages/OnecabDocuments";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <StaffProfileProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <Routes>
            {/* Public Auth Routes */}
            <Route path="/auth" element={<Auth />} />
            <Route path="/auth/reset" element={<AuthReset />} />
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
              
              {/* Service Areas */}
              <Route path="regions" element={<Regions />} />
              <Route path="services" element={<Services />} />
              <Route path="service-area-pricing" element={<ServiceAreaPricing />} />
              <Route path="vehicle-types" element={<VehicleTypes />} />
              <Route path="documents" element={<Documents />} />
              
              {/* Fleet Management */}
              <Route path="drivers" element={<Drivers />} />
              <Route path="vehicles" element={<Vehicles />} />
              <Route path="riders" element={<Riders />} />
              
              {/* Pricing & Fares */}
              <Route path="promo-codes" element={<PromoCodes />} />
              <Route path="custom-zones" element={<CustomZones />} />
              <Route path="zone-pricing" element={<ZonePricing />} />
              
              
              <Route path="corporate-fares" element={<CorporateFares />} />
              <Route path="fare-simulator" element={<FareSimulator />} />
              
              {/* Airports & Terminals */}
              <Route path="airports" element={<Airports />} />
              
              {/* Corporate */}
              <Route path="corporate-accounts" element={<CorporateAccounts />} />
              <Route path="account-requests" element={<AccountRequests />} />
              <Route path="corporate-billing" element={<CorporateBilling />} />
              <Route path="corporate-reports" element={<CorporateReports />} />
              <Route path="corporate-settings" element={<CorporateSettings />} />
              
              {/* Users & Support */}
              <Route path="rider-feedback" element={<RiderFeedback />} />
              <Route path="suspensions" element={<AccountSuspension />} />
              <Route path="complaints" element={<ComplaintsDashboard />} />
              <Route path="tickets" element={<Tickets />} />
              <Route path="live-chat" element={<LiveChat />} />
              <Route path="categories" element={<SupportCategories />} />
              
              {/* Finance & Payouts */}
              <Route path="payments" element={<AdminPayments />} />
              <Route path="admin-payments" element={<AdminPayments />} />
              <Route path="admin-settlements" element={<AdminDriverSettlements />} />
              <Route path="driver-wallet" element={<DriverWallet />} />
              <Route path="payout-batches" element={<AdminPayoutBatches />} />
              <Route path="disputes" element={<Disputes />} />
              <Route path="dispute-settings" element={<DisputeSettings />} />
              
              {/* ONECAB Documents */}
              <Route path="onecab-documents" element={<OnecabDocuments />} />

              {/* Content & Legal */}
              <Route path="content" element={<ManageContent />} />
              
              {/* Settings */}
              <Route path="general-settings" element={<GeneralSettings />} />
              <Route path="integrations" element={<Integrations />} />
              <Route path="webhooks" element={<Webhooks />} />
              <Route path="system" element={<SystemRequirements />} />
              <Route path="roles" element={<RolesPermissions />} />
              <Route path="notifications" element={<Notifications />} />
              <Route path="profile" element={<AdminProfile />} />
            </Route>
            
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
      </StaffProfileProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
