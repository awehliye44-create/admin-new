import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "@/hooks/useAuth";
import { ProtectedRoute } from "@/components/ProtectedRoute";

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

import {
  DriverProfiles,
  CustomZones,
  ZonePricing,
  CorporateFares,
  FareSimulator,
  Airports,
  CorporateAccounts,
  AccountRequests,
  CorporateBilling,
  CorporateReports,
  CorporateSettings,
  Suspensions,
  Complaints,
  Tickets,
  Categories,
  Payments,
  DriverPayouts,
  Disputes,
  DisputeSettings,
  Content,
  GeneralSettings,
  Integrations,
  Webhooks,
  System,
} from "./pages/PlaceholderPage";
import Notifications from "./pages/Notifications";

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
            
            {/* Protected Admin Routes */}
            <Route path="/" element={<ProtectedRoute><Index /></ProtectedRoute>} />
            <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
            
            {/* Operations & Dispatch */}
            <Route path="/fleet-tracking" element={<ProtectedRoute><FleetTracking /></ProtectedRoute>} />
            <Route path="/active-trips" element={<ProtectedRoute><ActiveTrips /></ProtectedRoute>} />
            <Route path="/auto-dispatch" element={<ProtectedRoute><AutoDispatchRules /></ProtectedRoute>} />
            <Route path="/scheduled-rides" element={<ProtectedRoute><ScheduledRides /></ProtectedRoute>} />
            <Route path="/missed-cancelled" element={<ProtectedRoute><MissedCancelled /></ProtectedRoute>} />
            <Route path="/trip-history" element={<ProtectedRoute><TripHistory /></ProtectedRoute>} />
            <Route path="/manual-trip" element={<ProtectedRoute><ManualTrip /></ProtectedRoute>} />
            <Route path="/dispatch" element={<ProtectedRoute><Dispatch /></ProtectedRoute>} />
            
            {/* Service Areas */}
            <Route path="/regions" element={<ProtectedRoute><Regions /></ProtectedRoute>} />
            <Route path="/services" element={<ProtectedRoute><Services /></ProtectedRoute>} />
            <Route path="/service-area-pricing" element={<ProtectedRoute><ServiceAreaPricing /></ProtectedRoute>} />
            <Route path="/driver-profiles" element={<ProtectedRoute><Drivers /></ProtectedRoute>} />
            <Route path="/vehicle-types" element={<ProtectedRoute><VehicleTypes /></ProtectedRoute>} />
            <Route path="/documents" element={<ProtectedRoute><Documents /></ProtectedRoute>} />
            <Route path="/driver-categories" element={<ProtectedRoute><DriverCategories /></ProtectedRoute>} />
            
            {/* Fleet Management */}
            <Route path="/drivers" element={<ProtectedRoute><Drivers /></ProtectedRoute>} />
            <Route path="/vehicles" element={<ProtectedRoute><Vehicles /></ProtectedRoute>} />
            <Route path="/riders" element={<ProtectedRoute><Riders /></ProtectedRoute>} />
            
            {/* Pricing & Fares */}
            <Route path="/promo-codes" element={<ProtectedRoute><PromoCodes /></ProtectedRoute>} />
            <Route path="/custom-zones" element={<ProtectedRoute><CustomZones /></ProtectedRoute>} />
            <Route path="/zone-pricing" element={<ProtectedRoute><ZonePricing /></ProtectedRoute>} />
            <Route path="/corporate-fares" element={<ProtectedRoute><CorporateFares /></ProtectedRoute>} />
            <Route path="/fare-simulator" element={<ProtectedRoute><FareSimulator /></ProtectedRoute>} />
            
            {/* Airports & Terminals */}
            <Route path="/airports" element={<ProtectedRoute><Airports /></ProtectedRoute>} />
            
            {/* Corporate */}
            <Route path="/corporate-accounts" element={<ProtectedRoute><CorporateAccounts /></ProtectedRoute>} />
            <Route path="/account-requests" element={<ProtectedRoute><AccountRequests /></ProtectedRoute>} />
            <Route path="/corporate-billing" element={<ProtectedRoute><CorporateBilling /></ProtectedRoute>} />
            <Route path="/corporate-reports" element={<ProtectedRoute><CorporateReports /></ProtectedRoute>} />
            <Route path="/corporate-settings" element={<ProtectedRoute><CorporateSettings /></ProtectedRoute>} />
            
            {/* Users & Support */}
            <Route path="/rider-feedback" element={<ProtectedRoute><RiderFeedback /></ProtectedRoute>} />
            <Route path="/suspensions" element={<ProtectedRoute><Suspensions /></ProtectedRoute>} />
            <Route path="/complaints" element={<ProtectedRoute><Complaints /></ProtectedRoute>} />
            <Route path="/tickets" element={<ProtectedRoute><Tickets /></ProtectedRoute>} />
            <Route path="/categories" element={<ProtectedRoute><Categories /></ProtectedRoute>} />
            
            {/* Finance & Payouts */}
            <Route path="/payments" element={<ProtectedRoute><Payments /></ProtectedRoute>} />
            <Route path="/driver-payouts" element={<ProtectedRoute><DriverPayouts /></ProtectedRoute>} />
            <Route path="/disputes" element={<ProtectedRoute><Disputes /></ProtectedRoute>} />
            <Route path="/dispute-settings" element={<ProtectedRoute><DisputeSettings /></ProtectedRoute>} />
            
            {/* Content & Legal */}
            <Route path="/content" element={<ProtectedRoute><Content /></ProtectedRoute>} />
            
            {/* Settings */}
            <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
            <Route path="/general-settings" element={<ProtectedRoute><GeneralSettings /></ProtectedRoute>} />
            <Route path="/integrations" element={<ProtectedRoute><Integrations /></ProtectedRoute>} />
            <Route path="/webhooks" element={<ProtectedRoute><Webhooks /></ProtectedRoute>} />
            <Route path="/system" element={<ProtectedRoute><System /></ProtectedRoute>} />
            <Route path="/roles" element={<ProtectedRoute><RolesPermissions /></ProtectedRoute>} />
            <Route path="/notifications" element={<ProtectedRoute><Notifications /></ProtectedRoute>} />
            
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
