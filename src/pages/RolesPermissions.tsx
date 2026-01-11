import { useState, useEffect } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { 
  Shield, 
  Search, 
  UserPlus, 
  UserMinus, 
  Loader2, 
  AlertCircle, 
  CheckCircle,
  Users,
  Crown
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface UserRole {
  id: string;
  user_id: string;
  role: string;
  created_at: string;
}

export default function RolesPermissions() {
  const [userIdInput, setUserIdInput] = useState('');
  const [adminRoles, setAdminRoles] = useState<UserRole[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const fetchAdminRoles = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('user_roles')
        .select('*')
        .eq('role', 'admin')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setAdminRoles(data || []);
    } catch (err) {
      console.error('Error fetching admin roles:', err);
      setError('Failed to load admin roles');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchAdminRoles();
  }, []);

  const handleGrantAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const userId = userIdInput.trim();
    if (!userId) {
      setError('Please enter a user ID');
      return;
    }

    // Basic UUID validation
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(userId)) {
      setError('Invalid user ID format. Please enter a valid UUID.');
      return;
    }

    // Check if already admin
    const existingAdmin = adminRoles.find(r => r.user_id === userId);
    if (existingAdmin) {
      setError('This user is already an admin');
      return;
    }

    setIsSubmitting(true);

    try {
      const { error } = await supabase
        .from('user_roles')
        .insert({
          user_id: userId,
          role: 'admin'
        });

      if (error) {
        if (error.message.includes('duplicate')) {
          setError('This user already has the admin role');
        } else {
          throw error;
        }
      } else {
        setSuccess('Admin role granted successfully!');
        setUserIdInput('');
        await fetchAdminRoles();
      }
    } catch (err: any) {
      console.error('Error granting admin:', err);
      setError(err.message || 'Failed to grant admin role');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRevokeAdmin = async (userId: string) => {
    setError(null);
    setSuccess(null);
    setIsSubmitting(true);

    try {
      const { error } = await supabase
        .from('user_roles')
        .delete()
        .eq('user_id', userId)
        .eq('role', 'admin');

      if (error) throw error;

      setSuccess('Admin role revoked successfully!');
      await fetchAdminRoles();
    } catch (err: any) {
      console.error('Error revoking admin:', err);
      setError(err.message || 'Failed to revoke admin role');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AdminLayout 
      title="Roles & Permissions" 
      description="Manage admin access for users"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Grant Admin Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-primary" />
              Grant Admin Access
            </CardTitle>
            <CardDescription>
              Enter the user ID to grant admin privileges
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleGrantAdmin} className="space-y-4">
              {error && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              {success && (
                <Alert className="bg-green-500/10 border-green-500/30">
                  <CheckCircle className="h-4 w-4 text-green-500" />
                  <AlertDescription className="text-green-500">
                    {success}
                  </AlertDescription>
                </Alert>
              )}

              <div className="space-y-2">
                <Label htmlFor="user-id">User ID (UUID)</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="user-id"
                    type="text"
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    value={userIdInput}
                    onChange={(e) => setUserIdInput(e.target.value)}
                    className="pl-10 font-mono text-sm"
                    disabled={isSubmitting}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  You can find the user ID in Supabase Authentication → Users
                </p>
              </div>

              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Granting Access...
                  </>
                ) : (
                  <>
                    <Crown className="mr-2 h-4 w-4" />
                    Grant Admin Role
                  </>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Stats Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-primary" />
              Admin Statistics
            </CardTitle>
            <CardDescription>
              Overview of admin users
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                <Users className="h-8 w-8 text-primary" />
              </div>
              <div>
                <p className="text-3xl font-bold">{adminRoles.length}</p>
                <p className="text-sm text-muted-foreground">Total Admins</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Admin List */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            Current Admins
          </CardTitle>
          <CardDescription>
            All users with admin access
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : adminRoles.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Shield className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No admins found</p>
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User ID</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Granted On</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {adminRoles.map((role) => (
                    <TableRow key={role.id}>
                      <TableCell className="font-mono text-xs">
                        {role.user_id}
                      </TableCell>
                      <TableCell>
                        <Badge variant="default" className="bg-primary">
                          <Crown className="mr-1 h-3 w-3" />
                          {role.role}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {new Date(role.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => handleRevokeAdmin(role.user_id)}
                          disabled={isSubmitting}
                        >
                          <UserMinus className="mr-1 h-4 w-4" />
                          Revoke
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </AdminLayout>
  );
}
