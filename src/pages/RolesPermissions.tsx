import { useState, useEffect, useCallback } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { 
  Shield, 
  Search, 
  UserPlus, 
  UserMinus, 
  Loader2, 
  AlertCircle, 
  CheckCircle,
  Users,
  Crown,
  UserCog,
  User,
  History,
  RefreshCw,
  Edit,
  Trash2,
  Eye,
  Filter,
  Download,
  Mail,
  Calendar,
  Clock,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  Plus
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { format } from 'date-fns';

type AppRole = 'admin' | 'moderator' | 'user';

interface UserRole {
  id: string;
  user_id: string;
  role: AppRole;
  created_at: string;
  email?: string;
}

interface RoleActivity {
  id: string;
  action: 'granted' | 'revoked' | 'modified';
  user_id: string;
  role: AppRole;
  performed_by: string;
  performed_at: string;
  notes?: string;
}

const ROLE_CONFIG: Record<AppRole, { label: string; icon: typeof Crown; color: string; description: string }> = {
  admin: {
    label: 'Admin',
    icon: Crown,
    color: 'bg-amber-500/10 text-amber-500 border-amber-500/30',
    description: 'Full access to all features and settings'
  },
  moderator: {
    label: 'Moderator',
    icon: ShieldCheck,
    color: 'bg-blue-500/10 text-blue-500 border-blue-500/30',
    description: 'Can manage content and users, limited settings access'
  },
  user: {
    label: 'User',
    icon: User,
    color: 'bg-gray-500/10 text-gray-500 border-gray-500/30',
    description: 'Basic access to the platform'
  }
};

export default function RolesPermissions() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState('users');
  const [userIdInput, setUserIdInput] = useState('');
  const [emailInput, setEmailInput] = useState('');
  const [selectedRole, setSelectedRole] = useState<AppRole>('admin');
  const [allRoles, setAllRoles] = useState<UserRole[]>([]);
  const [filteredRoles, setFilteredRoles] = useState<UserRole[]>([]);
  const [activities, setActivities] = useState<RoleActivity[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterRole, setFilterRole] = useState<AppRole | 'all'>('all');
  
  // Dialog states
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showDetailsDialog, setShowDetailsDialog] = useState(false);
  const [selectedUserRole, setSelectedUserRole] = useState<UserRole | null>(null);
  const [editRole, setEditRole] = useState<AppRole>('user');
  const [activityNotes, setActivityNotes] = useState('');

  // Statistics
  const [stats, setStats] = useState({
    total: 0,
    admins: 0,
    moderators: 0,
    users: 0
  });

  const fetchAllRoles = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('user_roles')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      
      const rolesData = (data || []) as UserRole[];
      setAllRoles(rolesData);
      
      // Calculate stats
      setStats({
        total: rolesData.length,
        admins: rolesData.filter(r => r.role === 'admin').length,
        moderators: rolesData.filter(r => r.role === 'moderator').length,
        users: rolesData.filter(r => r.role === 'user').length
      });
    } catch (err) {
      console.error('Error fetching roles:', err);
      setError('Failed to load roles');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Filter roles based on search and filter
  useEffect(() => {
    let filtered = [...allRoles];
    
    if (filterRole !== 'all') {
      filtered = filtered.filter(r => r.role === filterRole);
    }
    
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(r => 
        r.user_id.toLowerCase().includes(query) ||
        (r.email && r.email.toLowerCase().includes(query))
      );
    }
    
    setFilteredRoles(filtered);
  }, [allRoles, searchQuery, filterRole]);

  useEffect(() => {
    fetchAllRoles();
  }, [fetchAllRoles]);

  const logActivity = (action: RoleActivity['action'], userId: string, role: AppRole, notes?: string) => {
    const newActivity: RoleActivity = {
      id: crypto.randomUUID(),
      action,
      user_id: userId,
      role,
      performed_by: user?.id || 'unknown',
      performed_at: new Date().toISOString(),
      notes
    };
    setActivities(prev => [newActivity, ...prev].slice(0, 100)); // Keep last 100 activities
  };

  const handleGrantRole = async (e: React.FormEvent) => {
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

    // Check if user already has this role
    const existingRole = allRoles.find(r => r.user_id === userId && r.role === selectedRole);
    if (existingRole) {
      setError(`This user already has the ${selectedRole} role`);
      return;
    }

    setIsSubmitting(true);

    try {
      const { error } = await supabase
        .from('user_roles')
        .insert({
          user_id: userId,
          role: selectedRole
        });

      if (error) {
        if (error.message.includes('duplicate')) {
          setError(`This user already has the ${selectedRole} role`);
        } else {
          throw error;
        }
      } else {
        setSuccess(`${ROLE_CONFIG[selectedRole].label} role granted successfully!`);
        setUserIdInput('');
        setEmailInput('');
        logActivity('granted', userId, selectedRole, activityNotes);
        setActivityNotes('');
        setShowAddDialog(false);
        await fetchAllRoles();
      }
    } catch (err: any) {
      console.error('Error granting role:', err);
      setError(err.message || 'Failed to grant role');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateRole = async () => {
    if (!selectedUserRole) return;
    
    setError(null);
    setSuccess(null);
    setIsSubmitting(true);

    try {
      // Delete old role
      const { error: deleteError } = await supabase
        .from('user_roles')
        .delete()
        .eq('id', selectedUserRole.id);

      if (deleteError) throw deleteError;

      // Insert new role
      const { error: insertError } = await supabase
        .from('user_roles')
        .insert({
          user_id: selectedUserRole.user_id,
          role: editRole
        });

      if (insertError) throw insertError;

      setSuccess(`Role updated to ${ROLE_CONFIG[editRole].label} successfully!`);
      logActivity('modified', selectedUserRole.user_id, editRole, `Changed from ${selectedUserRole.role} to ${editRole}`);
      setShowEditDialog(false);
      setSelectedUserRole(null);
      await fetchAllRoles();
    } catch (err: any) {
      console.error('Error updating role:', err);
      setError(err.message || 'Failed to update role');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRevokeRole = async () => {
    if (!selectedUserRole) return;
    
    setError(null);
    setSuccess(null);
    setIsSubmitting(true);

    try {
      const { error } = await supabase
        .from('user_roles')
        .delete()
        .eq('id', selectedUserRole.id);

      if (error) throw error;

      setSuccess(`${ROLE_CONFIG[selectedUserRole.role].label} role revoked successfully!`);
      logActivity('revoked', selectedUserRole.user_id, selectedUserRole.role);
      setShowDeleteDialog(false);
      setSelectedUserRole(null);
      await fetchAllRoles();
    } catch (err: any) {
      console.error('Error revoking role:', err);
      setError(err.message || 'Failed to revoke role');
    } finally {
      setIsSubmitting(false);
    }
  };

  const openEditDialog = (role: UserRole) => {
    setSelectedUserRole(role);
    setEditRole(role.role);
    setShowEditDialog(true);
  };

  const openDeleteDialog = (role: UserRole) => {
    setSelectedUserRole(role);
    setShowDeleteDialog(true);
  };

  const openDetailsDialog = (role: UserRole) => {
    setSelectedUserRole(role);
    setShowDetailsDialog(true);
  };

  const exportRoles = () => {
    const csvContent = [
      ['User ID', 'Role', 'Created At'].join(','),
      ...filteredRoles.map(r => [r.user_id, r.role, r.created_at].join(','))
    ].join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `roles-export-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const RoleBadge = ({ role }: { role: AppRole }) => {
    const config = ROLE_CONFIG[role];
    const Icon = config.icon;
    return (
      <Badge variant="outline" className={config.color}>
        <Icon className="mr-1 h-3 w-3" />
        {config.label}
      </Badge>
    );
  };

  return (
    <AdminLayout 
      title="Roles & Permissions" 
      description="Manage user roles and access permissions across the platform"
    >
      {/* Success/Error Alerts */}
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {success && (
        <Alert className="mb-4 bg-green-500/10 border-green-500/30">
          <CheckCircle className="h-4 w-4 text-green-500" />
          <AlertDescription className="text-green-500">{success}</AlertDescription>
        </Alert>
      )}

      {/* Statistics Cards */}
      <div className="grid gap-4 md:grid-cols-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <Users className="h-6 w-6 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stats.total}</p>
                <p className="text-sm text-muted-foreground">Total Roles</p>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10">
                <Crown className="h-6 w-6 text-amber-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stats.admins}</p>
                <p className="text-sm text-muted-foreground">Admins</p>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-500/10">
                <ShieldCheck className="h-6 w-6 text-blue-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stats.moderators}</p>
                <p className="text-sm text-muted-foreground">Moderators</p>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gray-500/10">
                <User className="h-6 w-6 text-gray-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stats.users}</p>
                <p className="text-sm text-muted-foreground">Users</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="flex items-center justify-between mb-4">
          <TabsList>
            <TabsTrigger value="users" className="gap-2">
              <UserCog className="h-4 w-4" />
              User Roles
            </TabsTrigger>
            <TabsTrigger value="activity" className="gap-2">
              <History className="h-4 w-4" />
              Activity Log
            </TabsTrigger>
            <TabsTrigger value="permissions" className="gap-2">
              <Shield className="h-4 w-4" />
              Permissions Matrix
            </TabsTrigger>
          </TabsList>
          
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={fetchAllRoles} disabled={isLoading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button size="sm" onClick={() => setShowAddDialog(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Role
            </Button>
          </div>
        </div>

        {/* User Roles Tab */}
        <TabsContent value="users">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>User Roles Management</CardTitle>
                  <CardDescription>View and manage roles assigned to users</CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={exportRoles}>
                  <Download className="h-4 w-4 mr-2" />
                  Export CSV
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {/* Search and Filter */}
              <div className="flex items-center gap-4 mb-4">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by user ID or email..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10"
                  />
                </div>
                <Select value={filterRole} onValueChange={(v) => setFilterRole(v as AppRole | 'all')}>
                  <SelectTrigger className="w-[180px]">
                    <Filter className="h-4 w-4 mr-2" />
                    <SelectValue placeholder="Filter by role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Roles</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="moderator">Moderator</SelectItem>
                    <SelectItem value="user">User</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Roles Table */}
              {isLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : filteredRoles.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <ShieldQuestion className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No roles found</p>
                  <p className="text-sm mt-1">
                    {searchQuery || filterRole !== 'all' 
                      ? 'Try adjusting your search or filter' 
                      : 'Add a role to get started'}
                  </p>
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
                      {filteredRoles.map((role) => (
                        <TableRow key={role.id}>
                          <TableCell>
                            <div className="flex flex-col">
                              <span className="font-mono text-xs">{role.user_id}</span>
                              {role.email && (
                                <span className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                                  <Mail className="h-3 w-3" />
                                  {role.email}
                                </span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <RoleBadge role={role.role} />
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1 text-sm text-muted-foreground">
                              <Calendar className="h-3 w-3" />
                              {format(new Date(role.created_at), 'MMM d, yyyy')}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-2">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openDetailsDialog(role)}
                              >
                                <Eye className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openEditDialog(role)}
                              >
                                <Edit className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="text-destructive hover:text-destructive"
                                onClick={() => openDeleteDialog(role)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Activity Log Tab */}
        <TabsContent value="activity">
          <Card>
            <CardHeader>
              <CardTitle>Role Activity Log</CardTitle>
              <CardDescription>Recent role changes and modifications</CardDescription>
            </CardHeader>
            <CardContent>
              {activities.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <History className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No activity recorded yet</p>
                  <p className="text-sm mt-1">Role changes will appear here</p>
                </div>
              ) : (
                <ScrollArea className="h-[400px]">
                  <div className="space-y-4">
                    {activities.map((activity) => (
                      <div key={activity.id} className="flex items-start gap-4 p-4 rounded-lg border">
                        <div className={`flex h-10 w-10 items-center justify-center rounded-full ${
                          activity.action === 'granted' ? 'bg-green-500/10' :
                          activity.action === 'revoked' ? 'bg-red-500/10' : 'bg-blue-500/10'
                        }`}>
                          {activity.action === 'granted' && <UserPlus className="h-5 w-5 text-green-500" />}
                          {activity.action === 'revoked' && <UserMinus className="h-5 w-5 text-red-500" />}
                          {activity.action === 'modified' && <Edit className="h-5 w-5 text-blue-500" />}
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium capitalize">{activity.action}</span>
                            <RoleBadge role={activity.role} />
                          </div>
                          <p className="text-sm text-muted-foreground mt-1">
                            User ID: <span className="font-mono">{activity.user_id.slice(0, 8)}...</span>
                          </p>
                          {activity.notes && (
                            <p className="text-sm text-muted-foreground mt-1">{activity.notes}</p>
                          )}
                          <div className="flex items-center gap-1 text-xs text-muted-foreground mt-2">
                            <Clock className="h-3 w-3" />
                            {format(new Date(activity.performed_at), 'MMM d, yyyy HH:mm')}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Permissions Matrix Tab */}
        <TabsContent value="permissions">
          <Card>
            <CardHeader>
              <CardTitle>Permissions Matrix</CardTitle>
              <CardDescription>Overview of permissions for each role</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[300px]">Permission</TableHead>
                      <TableHead className="text-center">
                        <div className="flex items-center justify-center gap-2">
                          <Crown className="h-4 w-4 text-amber-500" />
                          Admin
                        </div>
                      </TableHead>
                      <TableHead className="text-center">
                        <div className="flex items-center justify-center gap-2">
                          <ShieldCheck className="h-4 w-4 text-blue-500" />
                          Moderator
                        </div>
                      </TableHead>
                      <TableHead className="text-center">
                        <div className="flex items-center justify-center gap-2">
                          <User className="h-4 w-4 text-gray-500" />
                          User
                        </div>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[
                      { name: 'View Dashboard', admin: true, moderator: true, user: false },
                      { name: 'Manage Drivers', admin: true, moderator: true, user: false },
                      { name: 'Manage Riders', admin: true, moderator: true, user: false },
                      { name: 'View Trip History', admin: true, moderator: true, user: false },
                      { name: 'Manage Active Trips', admin: true, moderator: true, user: false },
                      { name: 'Create Manual Trips', admin: true, moderator: true, user: false },
                      { name: 'Manage Regions', admin: true, moderator: false, user: false },
                      { name: 'Manage Service Areas', admin: true, moderator: false, user: false },
                      { name: 'Configure Pricing', admin: true, moderator: false, user: false },
                      { name: 'Manage Promo Codes', admin: true, moderator: true, user: false },
                      { name: 'View Documents', admin: true, moderator: true, user: false },
                      { name: 'Approve Documents', admin: true, moderator: false, user: false },
                      { name: 'Manage Notifications', admin: true, moderator: true, user: false },
                      { name: 'Manage Roles & Permissions', admin: true, moderator: false, user: false },
                      { name: 'Access Settings', admin: true, moderator: false, user: false },
                      { name: 'Export Data', admin: true, moderator: true, user: false },
                      { name: 'View Analytics', admin: true, moderator: true, user: false },
                    ].map((perm, idx) => (
                      <TableRow key={idx}>
                        <TableCell className="font-medium">{perm.name}</TableCell>
                        <TableCell className="text-center">
                          {perm.admin ? (
                            <CheckCircle className="h-5 w-5 text-green-500 mx-auto" />
                          ) : (
                            <div className="h-5 w-5 rounded-full border-2 border-muted mx-auto" />
                          )}
                        </TableCell>
                        <TableCell className="text-center">
                          {perm.moderator ? (
                            <CheckCircle className="h-5 w-5 text-green-500 mx-auto" />
                          ) : (
                            <div className="h-5 w-5 rounded-full border-2 border-muted mx-auto" />
                          )}
                        </TableCell>
                        <TableCell className="text-center">
                          {perm.user ? (
                            <CheckCircle className="h-5 w-5 text-green-500 mx-auto" />
                          ) : (
                            <div className="h-5 w-5 rounded-full border-2 border-muted mx-auto" />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Add Role Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-primary" />
              Grant New Role
            </DialogTitle>
            <DialogDescription>
              Assign a role to a user by their user ID
            </DialogDescription>
          </DialogHeader>
          
          <form onSubmit={handleGrantRole} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="add-user-id">User ID (UUID)</Label>
              <div className="relative">
                <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input
                  id="add-user-id"
                  type="text"
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  value={userIdInput}
                  onChange={(e) => setUserIdInput(e.target.value)}
                  className="pl-10 font-mono text-sm"
                  disabled={isSubmitting}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Find the user ID in Supabase Authentication → Users
              </p>
            </div>

            <div className="space-y-2">
              <Label>Role to Assign</Label>
              <Select value={selectedRole} onValueChange={(v) => setSelectedRole(v as AppRole)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(ROLE_CONFIG).map(([key, config]) => (
                    <SelectItem key={key} value={key}>
                      <div className="flex items-center gap-2">
                        <config.icon className="h-4 w-4" />
                        {config.label}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {ROLE_CONFIG[selectedRole].description}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">Notes (Optional)</Label>
              <Textarea
                id="notes"
                placeholder="Add any notes about this role assignment..."
                value={activityNotes}
                onChange={(e) => setActivityNotes(e.target.value)}
                rows={2}
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowAddDialog(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Granting...
                  </>
                ) : (
                  <>
                    <Crown className="mr-2 h-4 w-4" />
                    Grant Role
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Role Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Edit className="h-5 w-5 text-primary" />
              Change Role
            </DialogTitle>
            <DialogDescription>
              Update the role for this user
            </DialogDescription>
          </DialogHeader>
          
          {selectedUserRole && (
            <div className="space-y-4">
              <div className="p-3 rounded-lg bg-muted">
                <p className="text-xs text-muted-foreground">User ID</p>
                <p className="font-mono text-sm">{selectedUserRole.user_id}</p>
              </div>

              <div className="space-y-2">
                <Label>Current Role</Label>
                <div className="flex items-center gap-2">
                  <RoleBadge role={selectedUserRole.role} />
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <Label>New Role</Label>
                <Select value={editRole} onValueChange={(v) => setEditRole(v as AppRole)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(ROLE_CONFIG).map(([key, config]) => (
                      <SelectItem key={key} value={key}>
                        <div className="flex items-center gap-2">
                          <config.icon className="h-4 w-4" />
                          {config.label}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setShowEditDialog(false)}>
                  Cancel
                </Button>
                <Button onClick={handleUpdateRole} disabled={isSubmitting || editRole === selectedUserRole.role}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Updating...
                    </>
                  ) : (
                    'Update Role'
                  )}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <ShieldAlert className="h-5 w-5" />
              Revoke Role
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to revoke this role? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          
          {selectedUserRole && (
            <div className="space-y-4">
              <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">User ID</p>
                    <p className="font-mono text-sm">{selectedUserRole.user_id.slice(0, 20)}...</p>
                  </div>
                  <RoleBadge role={selectedUserRole.role} />
                </div>
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setShowDeleteDialog(false)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={handleRevokeRole} disabled={isSubmitting}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Revoking...
                    </>
                  ) : (
                    <>
                      <UserMinus className="mr-2 h-4 w-4" />
                      Revoke Role
                    </>
                  )}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Details Dialog */}
      <Dialog open={showDetailsDialog} onOpenChange={setShowDetailsDialog}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-primary" />
              Role Details
            </DialogTitle>
          </DialogHeader>
          
          {selectedUserRole && (
            <div className="space-y-4">
              <div className="grid gap-4">
                <div className="p-4 rounded-lg border">
                  <p className="text-xs text-muted-foreground mb-1">User ID</p>
                  <p className="font-mono text-sm break-all">{selectedUserRole.user_id}</p>
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 rounded-lg border">
                    <p className="text-xs text-muted-foreground mb-2">Role</p>
                    <RoleBadge role={selectedUserRole.role} />
                  </div>
                  
                  <div className="p-4 rounded-lg border">
                    <p className="text-xs text-muted-foreground mb-1">Granted On</p>
                    <p className="text-sm font-medium">
                      {format(new Date(selectedUserRole.created_at), 'MMM d, yyyy')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(selectedUserRole.created_at), 'HH:mm')}
                    </p>
                  </div>
                </div>
                
                <div className="p-4 rounded-lg border">
                  <p className="text-xs text-muted-foreground mb-2">Role Permissions</p>
                  <p className="text-sm">{ROLE_CONFIG[selectedUserRole.role].description}</p>
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setShowDetailsDialog(false)}>
                  Close
                </Button>
                <Button onClick={() => {
                  setShowDetailsDialog(false);
                  openEditDialog(selectedUserRole);
                }}>
                  <Edit className="mr-2 h-4 w-4" />
                  Edit Role
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
