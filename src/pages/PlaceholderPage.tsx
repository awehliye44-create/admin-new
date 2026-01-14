import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Construction } from 'lucide-react';

interface PlaceholderPageProps {
  title: string;
  description: string;
}

export function PlaceholderPage({ title, description }: PlaceholderPageProps) {
  return (
    <AdminLayout title={title} description={description}>
      <Card>
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <Construction className="h-8 w-8 text-primary" />
          </div>
          <CardTitle>Coming Soon</CardTitle>
          <CardDescription>
            This feature is currently under development.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-center">
          <p className="text-muted-foreground">
            We're working hard to bring you this functionality. Check back soon!
          </p>
        </CardContent>
      </Card>
    </AdminLayout>
  );
}

// Export specific placeholder pages
export const FleetTracking = () => <PlaceholderPage title="Live Fleet Tracking" description="Track your fleet in real-time" />;
export const ActiveTrips = () => <PlaceholderPage title="Active Trips (Real-time)" description="View and manage active trips" />;
export const AutoDispatch = () => <PlaceholderPage title="Auto-Dispatch Rules" description="Configure automatic dispatch settings" />;
export const ScheduledRides = () => <PlaceholderPage title="Scheduled Rides" description="Manage scheduled rides" />;
export const MissedCancelled = () => <PlaceholderPage title="Missed & Canceled" description="View missed and canceled trips" />;
export const ManualTrip = () => <PlaceholderPage title="Manual Trip Creation" description="Create trips manually" />;
export const DriverProfiles = () => <PlaceholderPage title="Driver Profiles" description="Manage driver profiles" />;
export const VehicleTypes = () => <PlaceholderPage title="Vehicle Types" description="Manage vehicle types and categories" />;
export const Documents = () => <PlaceholderPage title="Document Management" description="Manage driver and vehicle documents" />;
export const DriverCategories = () => <PlaceholderPage title="Driver Categories" description="Manage driver categories" />;
export const PromoCodes = () => <PlaceholderPage title="Promo Codes" description="Create and manage promotional codes" />;
// CustomZones, ZonePricing, CorporateFares, FareSimulator moved to dedicated files
export const Airports = () => <PlaceholderPage title="Manage Airports" description="Configure airport pickup and dropoff zones" />;

export const RiderFeedback = () => <PlaceholderPage title="Rider Feedback" description="View and manage rider feedback" />;
export const Suspensions = () => <PlaceholderPage title="Account Suspension" description="Manage suspended accounts" />;
export const Complaints = () => <PlaceholderPage title="Complaints Dashboard" description="Handle customer complaints" />;
export const Tickets = () => <PlaceholderPage title="Tickets" description="Manage support tickets" />;
export const Categories = () => <PlaceholderPage title="Categories" description="Manage ticket and complaint categories" />;
export const Content = () => <PlaceholderPage title="Manage Content" description="Edit app content and legal documents" />;
// GeneralSettings, Integrations and Webhooks moved to dedicated files
export const System = () => <PlaceholderPage title="System Requirements" description="View system requirements and status" />;
export const Notifications = () => <PlaceholderPage title="Notifications & Alerts" description="Configure notification settings" />;
