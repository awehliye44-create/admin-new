import { useEffect, useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { Plus, Navigation, Loader2 } from 'lucide-react';
import { format } from 'date-fns';

interface ServiceArea {
  id: string;
  name: string;
  region_id: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  region?: {
    name: string;
  };
}

export default function Services() {
  const [serviceAreas, setServiceAreas] = useState<ServiceArea[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchServiceAreas() {
      try {
        const { data, error } = await supabase
          .from('service_areas')
          .select(`
            *,
            region:regions(name)
          `)
          .order('created_at', { ascending: false });

        if (error) {
          throw error;
        }

        setServiceAreas(data || []);
      } catch (err) {
        console.error('Error fetching service areas:', err);
        setError('Failed to load service areas. Please try again.');
      } finally {
        setIsLoading(false);
      }
    }

    fetchServiceAreas();
  }, []);

  return (
    <AdminLayout 
      title="Service Areas" 
      description="Manage service zones within your regions"
    >
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Navigation className="h-5 w-5 text-primary" />
            All Service Areas
          </CardTitle>
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            Add Service Area
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : error ? (
            <div className="py-8 text-center text-destructive">{error}</div>
          ) : serviceAreas.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              No service areas found. Create your first service area to get started.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {serviceAreas.map((area) => (
                  <TableRow key={area.id}>
                    <TableCell className="font-medium">{area.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {area.region?.name || 'Unknown'}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={area.is_active ? 'default' : 'secondary'}
                        className={
                          area.is_active
                            ? 'bg-green-500/10 text-green-600 hover:bg-green-500/20'
                            : ''
                        }
                      >
                        {area.is_active ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {format(new Date(area.created_at), 'MMM d, yyyy')}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {format(new Date(area.updated_at), 'MMM d, yyyy')}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm">
                        Edit
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </AdminLayout>
  );
}
