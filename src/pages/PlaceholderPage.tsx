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

// Only exports that are actually used in App.tsx routes
export const Airports = () => <PlaceholderPage title="Manage Airports" description="Configure airport pickup and dropoff zones" />;
export const System = () => <PlaceholderPage title="System Requirements" description="View system requirements and status" />;
