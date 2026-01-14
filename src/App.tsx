import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "@/hooks/useAuth";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AdminShell } from "@/components/layout/AdminShell";

import Auth from "./pages/Auth";
import AuthReset from "./pages/AuthReset";
import Index from "./pages/Index";
import Dashboard from "./pages/Dashboard";
import Drivers from "./pages/Drivers";
import Riders from "./pages/Riders";
import Vehicles from "./pages/Vehicles";
import Regions from "./pages/Regions";
import Services from "./pages/Services";
import ServiceAreaPricing from "./pages/ServiceAreaPricing";
import Dispatch from "./pages/Dispatch";
import Settings from "./pages/Settings";
import RolesPermissions from "./pages/RolesPermissions";
import NotFound from "./pages/NotFound";
import AutoDispatchRules from "./pages/AutoDispatchRules";
import FleetTracking from "./pages/FleetTracking";
import ActiveTrips from "./pages/ActiveTrips";
import VehicleTypes from "./pages/VehicleTypes";
import RiderFeedback from "./pages/RiderFeedback";

import ScheduledRides from "./pages/ScheduledRides";
import MissedCancelled from "./pages/MissedCancelled";
import ManualTrip from "./pages/ManualTrip";
import TripHistory from "./pages/TripHistory";

import Documents from "./pages/Documents";
import DriverCategories from "./pages/DriverCategories";
import PromoCodes from "./pages/PromoCodes";
import CustomZones from "./pages/CustomZones";
import ZonePricing from "./pages/ZonePricing";
import CorporateFares from "./pages/CorporateFares";
import FareSimulator from "./pages/FareSimulator";
import Integrations from "./pages/Integrations";
import CorporateAccounts from "./pages/CorporateAccounts";
import AccountRequests from "./pages/AccountRequests";
import CorporateBilling from "./pages/CorporateBilling";
import CorporateReports from "./pages/CorporateReports";
import Webhooks from "./pages/Webhooks";
import CorporateSettings from "./pages/CorporateSettings";
import Payments from "./pages/Payments";
import DriverPayouts from "./pages/DriverPayouts";
import Disputes from "./pages/Disputes";
import DisputeSettings from "./pages/DisputeSettings";

import {
  Airports,
  Content,
  System,
} from "./pages/PlaceholderPage";
import AccountSuspension from "./pages/AccountSuspension";
import ComplaintsDashboard from "./pages/ComplaintsDashboard";
import Tickets from "./pages/Tickets";
import SupportCategories from "./pages/SupportCategories";
import GeneralSettings from "./pages/GeneralSettings";
import Notifications from "./pages/Notifications";
import SystemRequirements from "./pages/SystemRequirements";
import AdminProfile from "./pages/AdminProfile";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
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
              <Route path="driver-profiles" element={<Drivers />} />
              <Route path="vehicle-types" element={<VehicleTypes />} />
              <Route path="documents" element={<Documents />} />
              <Route path="driver-categories" element={<DriverCategories />} />
              
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
              <Route path="categories" element={<SupportCategories />} />
              
              {/* Finance & Payouts */}
              <Route path="payments" element={<Payments />} />
              <Route path="driver-payouts" element={<DriverPayouts />} />
              <Route path="disputes" element={<Disputes />} />
              <Route path="dispute-settings" element={<DisputeSettings />} />
              
              {/* Content & Legal */}
              <Route path="content" element={<Content />} />
              
              {/* Settings */}
              <Route path="settings" element={<Settings />} />
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
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
