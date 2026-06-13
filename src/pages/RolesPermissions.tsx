import { useState, useEffect, useCallback, Fragment } from 'react';
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
import { Checkbox } from '@/components/ui/checkbox';
import {
  Shield,
  Search,
  UserPlus,
  Loader2,
  AlertCircle,
  CheckCircle,
  Users,
  Crown,
  UserCog,
  User,
  RefreshCw,
  Edit,
  Trash2,
  Eye,
  Filter,
  Download,
  Calendar,
  ShieldCheck,
  ShieldAlert,
  Plus,
  ArrowRightLeft,
  MapPin,
  Briefcase,
  DollarSign,
  Headphones,
  ClipboardCheck,
  History,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useStaffProfile, StaffRole, ROLE_LABELS, ROLE_PREFIXES } from '@/hooks/useStaffProfile';
import { format } from 'date-fns';

type AuditEventType =
  | 'roles.permission.toggle'
  | 'roles.staff.add'
  | 'roles.staff.edit'
  | 'roles.staff.reassign'
  | 'roles.staff.remove';

interface AuditLogRow {
  id: string;
  event_type: string;
  user_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
  actor_name?: string;
}

async function writeAudit(
  actorUserId: string | undefined,
  eventType: AuditEventType,
  details: Record<string, unknown>,
) {
  try {
    await supabase.from('audit_logs').insert([{
      event_type: eventType,
      user_id: actorUserId ?? null,
      details: details as never,
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    }]);
  } catch (e) {
    console.error('[audit] write failed', eventType, e);
  }
}

interface StaffMember {
  id: string;
  user_id: string;
  staff_role_id: string;
  full_name: string;
  username: string | null;
  role: StaffRole;
  is_active: boolean;
  created_at: string;
  service_areas: { id: string; service_area_id: string; name: string }[];
}

interface ServiceArea {
  id: string;
  name: string;
}

const ROLE_CONFIG: Record<StaffRole, { label: string; icon: typeof Crown; color: string; prefix: string }> = {
  super_admin: { label: 'Super Admin', icon: Crown, color: 'bg-amber-500/10 text-amber-500 border-amber-500/30', prefix: 'SA' },
  admin: { label: 'Admin', icon: ShieldCheck, color: 'bg-blue-500/10 text-blue-500 border-blue-500/30', prefix: 'AD' },
  operator: { label: 'Operator', icon: UserCog, color: 'bg-green-500/10 text-green-500 border-green-500/30', prefix: 'OP' },
  finance_manager: { label: 'Finance Manager', icon: DollarSign, color: 'bg-purple-500/10 text-purple-500 border-purple-500/30', prefix: 'FM' },
  customer_support: { label: 'Customer Support', icon: Headphones, color: 'bg-cyan-500/10 text-cyan-500 border-cyan-500/30', prefix: 'CS' },
  compliance_officer: { label: 'Compliance Officer', icon: ClipboardCheck, color: 'bg-orange-500/10 text-orange-500 border-orange-500/30', prefix: 'CO' },
};

export default function RolesPermissions() {
  const { user } = useAuth();
  const { canManageRoles } = useStaffProfile();
  const [activeTab, setActiveTab] = useState('staff');
  const [staffMembers, setStaffMembers] = useState<StaffMember[]>([]);
  const [serviceAreas, setServiceAreas] = useState<ServiceArea[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterRole, setFilterRole] = useState<StaffRole | 'all'>('all');

  // Dialog states
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showReassignDialog, setShowReassignDialog] = useState(false);
  const [showRemoveDialog, setShowRemoveDialog] = useState(false);
  const [showDetailsDialog, setShowDetailsDialog] = useState(false);
  const [selectedStaff, setSelectedStaff] = useState<StaffMember | null>(null);

  // Form states
  const [formUserUuid, setFormUserUuid] = useState('');
  const [formFullName, setFormFullName] = useState('');
  const [formUsername, setFormUsername] = useState('');
  const [formRole, setFormRole] = useState<StaffRole>('operator');
  const [formServiceAreas, setFormServiceAreas] = useState<string[]>([]);
  const [reassignRole, setReassignRole] = useState<StaffRole>('operator');

  // Permission matrix
  const [permissionMatrix, setPermissionMatrix] = useState<Record<string, Record<string, boolean>>>({});

  // Audit log
  const [auditLogs, setAuditLogs] = useState<AuditLogRow[]>([]);
  const [isAuditLoading, setIsAuditLoading] = useState(false);
  const [auditFilter, setAuditFilter] = useState<'all' | AuditEventType>('all');

  // Stats
  const stats = {
    total: staffMembers.length,
    super_admin: staffMembers.filter(s => s.role === 'super_admin').length,
    admin: staffMembers.filter(s => s.role === 'admin').length,
    operator: staffMembers.filter(s => s.role === 'operator').length,
    finance_manager: staffMembers.filter(s => s.role === 'finance_manager').length,
    customer_support: staffMembers.filter(s => s.role === 'customer_support').length,
    compliance_officer: staffMembers.filter(s => s.role === 'compliance_officer').length,
  };

  const fetchStaffMembers = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data: profiles, error: profilesError } = await supabase
        .from('staff_profiles')
        .select('*')
        .order('created_at', { ascending: false });

      if (profilesError) throw profilesError;

      // Fetch service area assignments for all staff
      const { data: assignments } = await supabase
        .from('staff_service_areas')
        .select('id, staff_id, service_area_id, service_areas(name)');

      const members: StaffMember[] = (profiles || []).map((p: any) => ({
        ...p,
        service_areas: (assignments || [])
          .filter((a: any) => a.staff_id === p.id)
          .map((a: any) => ({
            id: a.id,
            service_area_id: a.service_area_id,
            name: a.service_areas?.name || 'Unknown',
          })),
      }));

      setStaffMembers(members);
    } catch (err) {
      console.error('Error fetching staff:', err);
      setError('Failed to load staff members');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchServiceAreas = useCallback(async () => {
    const { data } = await supabase
      .from('service_areas')
      .select('id, name')
      .eq('is_active', true)
      .order('name');
    setServiceAreas(data || []);
  }, []);

  const fetchPermissionMatrix = useCallback(async () => {
    const { data } = await supabase
      .from('role_page_permissions')
      .select('role, page_slug, can_access');

    const matrix: Record<string, Record<string, boolean>> = {};
    (data || []).forEach((p: any) => {
      if (!matrix[p.page_slug]) matrix[p.page_slug] = {};
      matrix[p.page_slug][p.role] = p.can_access;
    });
    setPermissionMatrix(matrix);
  }, []);

  const fetchAuditLogs = useCallback(async () => {
    setIsAuditLoading(true);
    try {
      const { data } = await supabase
        .from('audit_logs')
        .select('id, event_type, user_id, details, created_at')
        .like('event_type', 'roles.%')
        .order('created_at', { ascending: false })
        .limit(200);

      const rows = (data || []) as unknown as AuditLogRow[];
      const userIds = Array.from(new Set(rows.map(r => r.user_id).filter(Boolean))) as string[];
      let nameById = new Map<string, string>();
      if (userIds.length) {
        const { data: profs } = await supabase
          .from('staff_profiles')
          .select('user_id, full_name, staff_role_id')
          .in('user_id', userIds);
        nameById = new Map((profs || []).map((p: any) => [p.user_id, `${p.full_name} (${p.staff_role_id})`]));
      }
      setAuditLogs(rows.map(r => ({ ...r, actor_name: r.user_id ? (nameById.get(r.user_id) ?? r.user_id.slice(0, 8)) : 'system' })));
    } catch (err) {
      console.error('Error fetching audit logs:', err);
    } finally {
      setIsAuditLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStaffMembers();
    fetchServiceAreas();
    fetchPermissionMatrix();
    fetchAuditLogs();
  }, [fetchStaffMembers, fetchServiceAreas, fetchPermissionMatrix, fetchAuditLogs]);

  const filteredStaff = staffMembers.filter(s => {
    if (filterRole !== 'all' && s.role !== filterRole) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        s.staff_role_id.toLowerCase().includes(q) ||
        s.full_name.toLowerCase().includes(q) ||
        (s.username && s.username.toLowerCase().includes(q))
      );
    }
    return true;
  });

  const resetForm = () => {
    setFormUserUuid('');
    setFormFullName('');
    setFormUsername('');
    setFormRole('operator');
    setFormServiceAreas([]);
  };

  const handleAddStaff = async () => {
    setError(null);
    setSuccess(null);

    if (!formUserUuid.trim() || !formFullName.trim()) {
      setError('User ID and Full Name are required');
      return;
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(formUserUuid.trim())) {
      setError('Invalid User ID format. Must be a valid UUID.');
      return;
    }

    setIsSubmitting(true);
    try {
      const { data: newProfile, error: insertError } = await supabase
        .from('staff_profiles')
        .insert({
          user_id: formUserUuid.trim(),
          full_name: formFullName.trim(),
          username: formUsername.trim() || null,
          role: formRole as any,
          staff_role_id: 'TEMP', // Will be auto-generated by trigger
          created_by: user?.id,
        })
        .select()
        .single();

      if (insertError) {
        if (insertError.message.includes('duplicate')) {
          setError('This user already has a staff profile or the username is taken');
        } else {
          throw insertError;
        }
        return;
      }

      // Assign service areas
      if (formServiceAreas.length > 0 && newProfile) {
        await supabase.from('staff_service_areas').insert(
          formServiceAreas.map(saId => ({
            staff_id: newProfile.id,
            service_area_id: saId,
          }))
        );
      }

      await writeAudit(user?.id, 'roles.staff.add', {
        target_user_id: formUserUuid.trim(),
        target_staff_id: newProfile?.id,
        full_name: formFullName.trim(),
        username: formUsername.trim() || null,
        role: formRole,
        service_area_ids: formServiceAreas,
      });

      setSuccess(`Staff member added as ${ROLE_LABELS[formRole]}`);
      resetForm();
      setShowAddDialog(false);
      await Promise.all([fetchStaffMembers(), fetchAuditLogs()]);
    } catch (err: any) {
      setError(err.message || 'Failed to add staff member');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEditStaff = async () => {
    if (!selectedStaff) return;
    setError(null);
    setIsSubmitting(true);

    try {
      await supabase
        .from('staff_profiles')
        .update({
          full_name: formFullName.trim(),
          username: formUsername.trim() || null,
        })
        .eq('id', selectedStaff.id);

      // Update service areas
      await supabase.from('staff_service_areas').delete().eq('staff_id', selectedStaff.id);
      if (formServiceAreas.length > 0) {
        await supabase.from('staff_service_areas').insert(
          formServiceAreas.map(saId => ({
            staff_id: selectedStaff.id,
            service_area_id: saId,
          }))
        );
      }

      await writeAudit(user?.id, 'roles.staff.edit', {
        target_staff_id: selectedStaff.id,
        target_user_id: selectedStaff.user_id,
        before: {
          full_name: selectedStaff.full_name,
          username: selectedStaff.username,
          service_area_ids: selectedStaff.service_areas.map(s => s.service_area_id),
        },
        after: {
          full_name: formFullName.trim(),
          username: formUsername.trim() || null,
          service_area_ids: formServiceAreas,
        },
      });

      setSuccess('Staff member updated');
      setShowEditDialog(false);
      await Promise.all([fetchStaffMembers(), fetchAuditLogs()]);
    } catch (err: any) {
      setError(err.message || 'Failed to update');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReassignRole = async () => {
    if (!selectedStaff) return;
    setError(null);
    setIsSubmitting(true);

    try {
      await supabase
        .from('staff_profiles')
        .update({ role: reassignRole as any })
        .eq('id', selectedStaff.id);

      await writeAudit(user?.id, 'roles.staff.reassign', {
        target_staff_id: selectedStaff.id,
        target_user_id: selectedStaff.user_id,
        full_name: selectedStaff.full_name,
        previous_role: selectedStaff.role,
        new_role: reassignRole,
      });

      setSuccess(`Role reassigned to ${ROLE_LABELS[reassignRole]}. New Staff ID will be generated.`);
      setShowReassignDialog(false);
      await Promise.all([fetchStaffMembers(), fetchAuditLogs()]);
    } catch (err: any) {
      setError(err.message || 'Failed to reassign role');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemoveStaff = async () => {
    if (!selectedStaff) return;
    setError(null);
    setIsSubmitting(true);

    try {
      // Remove service areas first
      await supabase.from('staff_service_areas').delete().eq('staff_id', selectedStaff.id);
      // Remove staff profile
      await supabase.from('staff_profiles').delete().eq('id', selectedStaff.id);
      // Remove profiles entry for this admin
      await supabase.from('profiles').delete().eq('user_id', selectedStaff.user_id);

      await writeAudit(user?.id, 'roles.staff.remove', {
        target_staff_id: selectedStaff.id,
        target_user_id: selectedStaff.user_id,
        full_name: selectedStaff.full_name,
        staff_role_id: selectedStaff.staff_role_id,
        role: selectedStaff.role,
      });

      setSuccess('Staff member removed');
      setShowRemoveDialog(false);
      setSelectedStaff(null);
      await Promise.all([fetchStaffMembers(), fetchAuditLogs()]);
    } catch (err: any) {
      setError(err.message || 'Failed to remove');
    } finally {
      setIsSubmitting(false);
    }
  };

  const openEditDialog = (staff: StaffMember) => {
    setSelectedStaff(staff);
    setFormFullName(staff.full_name);
    setFormUsername(staff.username || '');
    setFormServiceAreas(staff.service_areas.map(sa => sa.service_area_id));
    setShowEditDialog(true);
  };

  const openReassignDialog = (staff: StaffMember) => {
    setSelectedStaff(staff);
    setReassignRole(staff.role);
    setShowReassignDialog(true);
  };

  const exportStaff = () => {
    const csvContent = [
      ['Staff ID', 'Full Name', 'Username', 'Role', 'Service Areas', 'Created At'].join(','),
      ...filteredStaff.map(s => [
        s.staff_role_id,
        s.full_name,
        s.username || '',
        ROLE_LABELS[s.role],
        s.service_areas.map(sa => sa.name).join('; '),
        s.created_at,
      ].join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `staff-export-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const RoleBadge = ({ role }: { role: StaffRole }) => {
    const config = ROLE_CONFIG[role];
    const Icon = config.icon;
    return (
      <Badge variant="outline" className={config.color}>
        <Icon className="mr-1 h-3 w-3" />
        {config.label}
      </Badge>
    );
  };

  // Permission page groups for the matrix
  const PAGE_GROUPS = [
    { label: 'Dashboard', pages: ['dashboard'] },
    { label: 'Operations', pages: ['fleet-tracking', 'active-trips', 'auto-dispatch', 'scheduled-rides', 'missed-cancelled', 'trip-history', 'manual-trip', 'qr-booking'] },
    { label: 'Fleet', pages: ['drivers', 'vehicles', 'vehicle-types', 'documents', 'document-management'] },
    { label: 'Service Areas', pages: ['regions', 'services'] },
    { label: 'Pricing', pages: ['promo-codes', 'custom-zones', 'zone-pricing', 'corporate-fares', 'fare-simulator'] },
    { label: 'Corporate', pages: ['corporate-accounts', 'account-requests', 'corporate-billing', 'corporate-reports', 'corporate-settings'] },
    { label: 'Riders & Support', pages: ['riders', 'rider-feedback', 'suspensions', 'complaints', 'live-chat', 'tickets', 'categories'] },
    { label: 'Finance', pages: ['admin-payments', 'driver-wallet', 'admin-settlements', 'payout-batches', 'disputes', 'dispute-settings', 'invoices', 'invoice-templates', 'statement-runs'] },
    { label: 'Documents', pages: ['onecab-documents', 'content'] },
    { label: 'Settings', pages: ['general-settings', 'integrations', 'webhooks', 'roles', 'user-directory', 'notifications', 'alert-sounds'] },
  ];

  const ROLES_ORDER: StaffRole[] = ['super_admin', 'admin', 'operator', 'finance_manager', 'customer_support', 'compliance_officer'];

  const [togglingPerm, setTogglingPerm] = useState<string | null>(null);

  const handleTogglePermission = async (pageSlug: string, role: StaffRole) => {
    if (!canManageRoles) return;
    const key = `${pageSlug}-${role}`;
    setTogglingPerm(key);
    const currentAccess = permissionMatrix[pageSlug]?.[role] ?? false;
    const newAccess = !currentAccess;

    try {
      // Upsert the permission
      const { error: upsertError } = await supabase
        .from('role_page_permissions')
        .upsert(
          { role: role as any, page_slug: pageSlug, can_access: newAccess },
          { onConflict: 'role,page_slug' }
        );

      if (upsertError) throw upsertError;

      // Update local state
      setPermissionMatrix(prev => ({
        ...prev,
        [pageSlug]: {
          ...prev[pageSlug],
          [role]: newAccess,
        },
      }));

      await writeAudit(user?.id, 'roles.permission.toggle', {
        page_slug: pageSlug,
        role,
        previous_access: currentAccess,
        new_access: newAccess,
      });
      fetchAuditLogs();
    } catch (err: any) {
      console.error('Failed to toggle permission:', err);
      setError(`Failed to update permission: ${err.message}`);
    } finally {
      setTogglingPerm(null);
    }
  };

  return (
    <AdminLayout
      title="Roles & Permissions"
      description="Manage staff roles, permissions, and service area assignments"
    >
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

      {/* Stats Cards */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4 lg:grid-cols-7 mb-6">
        {([
          { key: 'total', label: 'Total Staff', icon: Users, color: 'text-primary' },
          { key: 'super_admin', label: 'Super Admins', icon: Crown, color: 'text-amber-500' },
          { key: 'admin', label: 'Admins', icon: ShieldCheck, color: 'text-blue-500' },
          { key: 'operator', label: 'Operators', icon: UserCog, color: 'text-green-500' },
          { key: 'finance_manager', label: 'Finance', icon: DollarSign, color: 'text-purple-500' },
          { key: 'customer_support', label: 'Support', icon: Headphones, color: 'text-cyan-500' },
          { key: 'compliance_officer', label: 'Compliance', icon: ClipboardCheck, color: 'text-orange-500' },
        ] as const).map(({ key, label, icon: Icon, color }) => (
          <Card key={key}>
            <CardContent className="pt-4 pb-3 px-4">
              <div className="flex items-center gap-2">
                <Icon className={`h-4 w-4 ${color}`} />
                <span className="text-lg font-bold">{stats[key]}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">{label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <TabsList>
            <TabsTrigger value="staff" className="gap-2">
              <UserCog className="h-4 w-4" />
              Staff Members
            </TabsTrigger>
            <TabsTrigger value="permissions" className="gap-2">
              <Shield className="h-4 w-4" />
              Permissions Matrix
            </TabsTrigger>
          </TabsList>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={fetchStaffMembers} disabled={isLoading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            {canManageRoles && (
              <Button size="sm" onClick={() => { resetForm(); setShowAddDialog(true); }}>
                <Plus className="h-4 w-4 mr-2" />
                Add Staff
              </Button>
            )}
          </div>
        </div>

        {/* Staff Members Tab */}
        <TabsContent value="staff">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Staff Members</CardTitle>
                  <CardDescription>Manage admin panel staff and their roles</CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={exportStaff}>
                  <Download className="h-4 w-4 mr-2" />
                  Export
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-4 mb-4">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by Staff ID, name, or username..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10"
                  />
                </div>
                <Select value={filterRole} onValueChange={(v) => setFilterRole(v as StaffRole | 'all')}>
                  <SelectTrigger className="w-[200px]">
                    <Filter className="h-4 w-4 mr-2" />
                    <SelectValue placeholder="Filter by role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Roles</SelectItem>
                    {ROLES_ORDER.map(r => (
                      <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {isLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : filteredStaff.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No staff members found</p>
                  <p className="text-sm mt-1">Add a staff member to get started</p>
                </div>
              ) : (
                <div className="rounded-md border overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Staff Role ID</TableHead>
                        <TableHead>Full Name</TableHead>
                        <TableHead>Username</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Service Area</TableHead>
                        <TableHead>Granted On</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredStaff.map((staff) => (
                        <TableRow key={staff.id}>
                          <TableCell>
                            <span className="font-mono font-semibold text-primary">
                              {staff.staff_role_id}
                            </span>
                          </TableCell>
                          <TableCell className="font-medium">{staff.full_name}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {staff.username || '—'}
                          </TableCell>
                          <TableCell>
                            <RoleBadge role={staff.role} />
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {staff.service_areas.length > 0 ? (
                                staff.service_areas.map(sa => (
                                  <Badge key={sa.id} variant="secondary" className="text-xs">
                                    <MapPin className="h-3 w-3 mr-1" />
                                    {sa.name}
                                  </Badge>
                                ))
                              ) : (
                                <span className="text-xs text-muted-foreground">All Areas</span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1 text-sm text-muted-foreground">
                              <Calendar className="h-3 w-3" />
                              {format(new Date(staff.created_at), 'MMM d, yyyy')}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button variant="ghost" size="icon" onClick={() => { setSelectedStaff(staff); setShowDetailsDialog(true); }}>
                                <Eye className="h-4 w-4" />
                              </Button>
                              {canManageRoles && (
                                <>
                                  <Button variant="ghost" size="icon" onClick={() => openEditDialog(staff)}>
                                    <Edit className="h-4 w-4" />
                                  </Button>
                                  <Button variant="ghost" size="icon" onClick={() => openReassignDialog(staff)}>
                                    <ArrowRightLeft className="h-4 w-4" />
                                  </Button>
                                  <Button variant="ghost" size="icon" className="text-destructive" onClick={() => { setSelectedStaff(staff); setShowRemoveDialog(true); }}>
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </>
                              )}
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

        {/* Permissions Matrix Tab */}
        <TabsContent value="permissions">
          <Card>
            <CardHeader>
              <CardTitle>Permissions Matrix</CardTitle>
              <CardDescription>Page access permissions for each role</CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="w-full">
                <div className="rounded-md border min-w-[800px]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[200px] sticky left-0 bg-background z-10">Page</TableHead>
                        {ROLES_ORDER.map(r => {
                          const config = ROLE_CONFIG[r];
                          const Icon = config.icon;
                          return (
                            <TableHead key={r} className="text-center min-w-[100px]">
                              <div className="flex items-center justify-center gap-1">
                                <Icon className="h-3 w-3" />
                                <span className="text-xs">{config.prefix}</span>
                              </div>
                            </TableHead>
                          );
                        })}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {PAGE_GROUPS.map(group => (
                        <>
                          <TableRow key={`group-${group.label}`} className="bg-muted/50">
                            <TableCell colSpan={ROLES_ORDER.length + 1} className="font-semibold text-xs uppercase tracking-wider py-2">
                              {group.label}
                            </TableCell>
                          </TableRow>
                          {group.pages.map(page => (
                            <TableRow key={page}>
                              <TableCell className="sticky left-0 bg-background z-10 capitalize text-sm">
                                {page.replace(/-/g, ' ')}
                              </TableCell>
                              {ROLES_ORDER.map(r => {
                                const key = `${page}-${r}`;
                                const hasAccess = permissionMatrix[page]?.[r] ?? false;
                                const isToggling = togglingPerm === key;
                                return (
                                  <TableCell key={r} className="text-center">
                                    {isToggling ? (
                                      <Loader2 className="h-4 w-4 animate-spin mx-auto text-muted-foreground" />
                                    ) : canManageRoles ? (
                                      <button
                                        onClick={() => handleTogglePermission(page, r)}
                                        className="mx-auto block cursor-pointer hover:scale-110 transition-transform"
                                        title={hasAccess ? `Revoke ${page} from ${ROLE_LABELS[r]}` : `Grant ${page} to ${ROLE_LABELS[r]}`}
                                      >
                                        {hasAccess ? (
                                          <CheckCircle className="h-4 w-4 text-green-500" />
                                        ) : (
                                          <div className="h-4 w-4 rounded-full border-2 border-muted-foreground/30 hover:border-primary" />
                                        )}
                                      </button>
                                    ) : (
                                      hasAccess ? (
                                        <CheckCircle className="h-4 w-4 text-green-500 mx-auto" />
                                      ) : (
                                        <div className="h-4 w-4 rounded-full border-2 border-muted mx-auto" />
                                      )
                                    )}
                                  </TableCell>
                                );
                              })}
                            </TableRow>
                          ))}
                        </>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Add Staff Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="sm:max-w-[550px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-primary" />
              Add Staff Member
            </DialogTitle>
            <DialogDescription>
              Create a new staff profile with role-based access
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>User ID (UUID)</Label>
              <Input
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                value={formUserUuid}
                onChange={(e) => setFormUserUuid(e.target.value)}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">Find in Supabase Authentication → Users</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Full Name *</Label>
                <Input value={formFullName} onChange={(e) => setFormFullName(e.target.value)} placeholder="John Smith" />
              </div>
              <div className="space-y-2">
                <Label>Username</Label>
                <Input value={formUsername} onChange={(e) => setFormUsername(e.target.value)} placeholder="jsmith" />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={formRole} onValueChange={(v) => setFormRole(v as StaffRole)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES_ORDER.map(r => (
                    <SelectItem key={r} value={r}>
                      <div className="flex items-center gap-2">
                        {(() => { const Icon = ROLE_CONFIG[r].icon; return <Icon className="h-4 w-4" />; })()}
                        {ROLE_LABELS[r]} ({ROLE_PREFIXES[r]})
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Staff ID will be auto-generated: {ROLE_PREFIXES[formRole]}XXX
              </p>
            </div>

            <div className="space-y-2">
              <Label>Assigned Service Areas</Label>
              <div className="border rounded-md p-3 max-h-[150px] overflow-y-auto space-y-2">
                {serviceAreas.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No service areas available</p>
                ) : (
                  serviceAreas.map(sa => (
                    <label key={sa.id} className="flex items-center gap-2 text-sm cursor-pointer">
                      <Checkbox
                        checked={formServiceAreas.includes(sa.id)}
                        onCheckedChange={(checked) => {
                          setFormServiceAreas(prev =>
                            checked ? [...prev, sa.id] : prev.filter(id => id !== sa.id)
                          );
                        }}
                      />
                      {sa.name}
                    </label>
                  ))
                )}
              </div>
              <p className="text-xs text-muted-foreground">Leave empty for access to all areas</p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddDialog(false)}>Cancel</Button>
            <Button onClick={handleAddStaff} disabled={isSubmitting}>
              {isSubmitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <UserPlus className="h-4 w-4 mr-2" />}
              Add Staff
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Staff Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Edit className="h-5 w-5 text-primary" />
              Edit Staff Member
            </DialogTitle>
          </DialogHeader>

          {selectedStaff && (
            <div className="space-y-4">
              <div className="p-3 rounded-lg bg-muted flex items-center gap-3">
                <span className="font-mono font-bold text-primary">{selectedStaff.staff_role_id}</span>
                <RoleBadge role={selectedStaff.role} />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Full Name</Label>
                  <Input value={formFullName} onChange={(e) => setFormFullName(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Username</Label>
                  <Input value={formUsername} onChange={(e) => setFormUsername(e.target.value)} />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Service Areas</Label>
                <div className="border rounded-md p-3 max-h-[150px] overflow-y-auto space-y-2">
                  {serviceAreas.map(sa => (
                    <label key={sa.id} className="flex items-center gap-2 text-sm cursor-pointer">
                      <Checkbox
                        checked={formServiceAreas.includes(sa.id)}
                        onCheckedChange={(checked) => {
                          setFormServiceAreas(prev =>
                            checked ? [...prev, sa.id] : prev.filter(id => id !== sa.id)
                          );
                        }}
                      />
                      {sa.name}
                    </label>
                  ))}
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setShowEditDialog(false)}>Cancel</Button>
                <Button onClick={handleEditStaff} disabled={isSubmitting}>
                  {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Save Changes
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Reassign Role Dialog */}
      <Dialog open={showReassignDialog} onOpenChange={setShowReassignDialog}>
        <DialogContent className="sm:max-w-[450px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowRightLeft className="h-5 w-5 text-primary" />
              Reassign Role
            </DialogTitle>
            <DialogDescription>
              Change the role for this staff member. A new Staff ID will be generated.
            </DialogDescription>
          </DialogHeader>

          {selectedStaff && (
            <div className="space-y-4">
              <div className="p-3 rounded-lg bg-muted">
                <p className="font-medium">{selectedStaff.full_name}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-sm text-muted-foreground">Current:</span>
                  <span className="font-mono text-sm">{selectedStaff.staff_role_id}</span>
                  <RoleBadge role={selectedStaff.role} />
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <Label>New Role</Label>
                <Select value={reassignRole} onValueChange={(v) => setReassignRole(v as StaffRole)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES_ORDER.map(r => (
                      <SelectItem key={r} value={r}>
                        <div className="flex items-center gap-2">
                          {(() => { const Icon = ROLE_CONFIG[r].icon; return <Icon className="h-4 w-4" />; })()}
                          {ROLE_LABELS[r]} ({ROLE_PREFIXES[r]})
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  New Staff ID: {ROLE_PREFIXES[reassignRole]}XXX
                </p>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setShowReassignDialog(false)}>Cancel</Button>
                <Button onClick={handleReassignRole} disabled={isSubmitting || reassignRole === selectedStaff.role}>
                  {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Reassign Role
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Remove Staff Dialog */}
      <Dialog open={showRemoveDialog} onOpenChange={setShowRemoveDialog}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <ShieldAlert className="h-5 w-5" />
              Remove Staff Access
            </DialogTitle>
            <DialogDescription>
              This will revoke all admin panel access for this staff member.
            </DialogDescription>
          </DialogHeader>

          {selectedStaff && (
            <div className="space-y-4">
              <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/30">
                <p className="font-medium">{selectedStaff.full_name}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="font-mono text-sm">{selectedStaff.staff_role_id}</span>
                  <RoleBadge role={selectedStaff.role} />
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setShowRemoveDialog(false)}>Cancel</Button>
                <Button variant="destructive" onClick={handleRemoveStaff} disabled={isSubmitting}>
                  {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Remove Access
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
              <Eye className="h-5 w-5 text-primary" />
              Staff Details
            </DialogTitle>
          </DialogHeader>

          {selectedStaff && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground">Staff Role ID</p>
                  <p className="font-mono font-bold text-lg text-primary">{selectedStaff.staff_role_id}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Role</p>
                  <div className="mt-1"><RoleBadge role={selectedStaff.role} /></div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Full Name</p>
                  <p className="font-medium">{selectedStaff.full_name}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Username</p>
                  <p className="font-medium">{selectedStaff.username || '—'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Status</p>
                  <Badge variant={selectedStaff.is_active ? 'default' : 'secondary'}>
                    {selectedStaff.is_active ? 'Active' : 'Inactive'}
                  </Badge>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Created</p>
                  <p className="text-sm">{format(new Date(selectedStaff.created_at), 'PPp')}</p>
                </div>
              </div>

              <Separator />

              <div>
                <p className="text-xs text-muted-foreground mb-2">Assigned Service Areas</p>
                <div className="flex flex-wrap gap-2">
                  {selectedStaff.service_areas.length > 0 ? (
                    selectedStaff.service_areas.map(sa => (
                      <Badge key={sa.id} variant="secondary">
                        <MapPin className="h-3 w-3 mr-1" />
                        {sa.name}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">Access to all service areas</span>
                  )}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
