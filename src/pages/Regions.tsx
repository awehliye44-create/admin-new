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
import { Plus, MapPin, Loader2 } from 'lucide-react';
import { format } from 'date-fns';

interface Region {
  id: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export default function Regions() {
  const [regions, setRegions] = useState<Region[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchRegions() {
      try {
        const { data, error } = await supabase
          .from('regions')
          .select('*')
          .order('created_at', { ascending: false });

        if (error) {
          throw error;
        }

        setRegions(data || []);
      } catch (err) {
        console.error('Error fetching regions:', err);
        setError('Failed to load regions. Please try again.');
      } finally {
        setIsLoading(false);
      }
    }

    fetchRegions();
  }, []);

  return (
    <AdminLayout 
      title="Regions" 
      description="Manage operational regions for your service"
    >
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5 text-primary" />
            All Regions
          </CardTitle>
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            Add Region
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : error ? (
            <div className="py-8 text-center text-destructive">{error}</div>
          ) : regions.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              No regions found. Create your first region to get started.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {regions.map((region) => (
                  <TableRow key={region.id}>
                    <TableCell className="font-medium">{region.name}</TableCell>
                    <TableCell>
                      <Badge
                        variant={region.status === 'active' ? 'default' : 'secondary'}
                        className={
                          region.status === 'active'
                            ? 'bg-green-500/10 text-green-600 hover:bg-green-500/20'
                            : ''
                        }
                      >
                        {region.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {format(new Date(region.created_at), 'MMM d, yyyy')}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {format(new Date(region.updated_at), 'MMM d, yyyy')}
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
