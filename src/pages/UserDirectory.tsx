import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search, Users, ShieldCheck, Car, UserCircle, Building2, Loader2 } from 'lucide-react';

interface DirectoryUser {
  user_id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  user_type: string;
  status: string;
  has_linked_record: boolean;
  created_at: string;
}

const USER_TYPE_CONFIG: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  admin: { label: 'Admin', icon: <ShieldCheck className="h-3.5 w-3.5" />, color: 'bg-primary/15 text-primary border-primary/30' },
  driver: { label: 'Driver', icon: <Car className="h-3.5 w-3.5" />, color: 'bg-blue-500/15 text-blue-600 border-blue-500/30' },
  customer: { label: 'Customer', icon: <UserCircle className="h-3.5 w-3.5" />, color: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30' },
  corporate: { label: 'Corporate', icon: <Building2 className="h-3.5 w-3.5" />, color: 'bg-amber-500/15 text-amber-600 border-amber-500/30' },
};

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  approved: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  pending: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  inactive: 'bg-muted text-muted-foreground',
  rejected: 'bg-destructive/15 text-destructive border-destructive/30',
  suspended: 'bg-destructive/15 text-destructive border-destructive/30',
};

export default function UserDirectory() {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['user-directory'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('user_directory' as any)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data || []) as unknown as DirectoryUser[];
    },
  });

  const filtered = useMemo(() => {
    let result = users;
    if (typeFilter !== 'all') {
      result = result.filter(u => u.user_type === typeFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(u =>
        (u.full_name?.toLowerCase().includes(q)) ||
        (u.email?.toLowerCase().includes(q)) ||
        (u.phone?.includes(q)) ||
        (u.user_id?.toLowerCase().includes(q))
      );
    }
    return result;
  }, [users, typeFilter, search]);

  // Summary counts
  const counts = useMemo(() => {
    const c: Record<string, number> = { admin: 0, driver: 0, customer: 0, corporate: 0 };
    users.forEach(u => { c[u.user_type] = (c[u.user_type] || 0) + 1; });
    return c;
  }, [users]);

  return (
    <AdminLayout
      title="User Directory"
      description="Single source of truth — every authenticated user classified by type"
    >
      <div className="space-y-6">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Object.entries(USER_TYPE_CONFIG).map(([type, cfg]) => (
            <Card
              key={type}
              className={`cursor-pointer transition-all ${typeFilter === type ? 'ring-2 ring-primary' : ''}`}
              onClick={() => setTypeFilter(typeFilter === type ? 'all' : type)}
            >
              <CardContent className="flex items-center gap-3 p-4">
                <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${cfg.color}`}>
                  {cfg.icon}
                </div>
                <div>
                  <p className="text-2xl font-bold text-foreground">{counts[type] || 0}</p>
                  <p className="text-xs text-muted-foreground">{cfg.label}s</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Filters */}
        <Card>
          <CardHeader className="pb-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <CardTitle className="text-lg">All Users</CardTitle>
                <CardDescription>{filtered.length} of {users.length} users</CardDescription>
              </div>
              <div className="flex items-center gap-3 w-full sm:w-auto">
                <div className="relative flex-1 sm:w-64">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search name, email, phone, ID..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="pl-10"
                  />
                </div>
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger className="w-36">
                    <SelectValue placeholder="All types" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="driver">Driver</SelectItem>
                    <SelectItem value="customer">Customer</SelectItem>
                    <SelectItem value="corporate">Corporate</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <Users className="h-10 w-10 mb-3 opacity-40" />
                <p className="text-sm">No users found</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Contact</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Linked Record</TableHead>
                    <TableHead>Joined</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((u, i) => {
                    const cfg = USER_TYPE_CONFIG[u.user_type] || USER_TYPE_CONFIG.customer;
                    const statusColor = STATUS_COLORS[u.status] || STATUS_COLORS.active;
                    return (
                      <TableRow key={`${u.user_id}-${u.user_type}-${i}`}>
                        <TableCell>
                          <div>
                            <p className="font-medium text-foreground">{u.full_name}</p>
                            <p className="text-xs text-muted-foreground font-mono">{u.user_id?.slice(0, 8)}…</p>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`gap-1 ${cfg.color}`}>
                            {cfg.icon}
                            {cfg.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-0.5">
                            {u.email && <p className="text-sm text-foreground">{u.email}</p>}
                            {u.phone && <p className="text-xs text-muted-foreground">{u.phone}</p>}
                            {!u.email && !u.phone && <span className="text-xs text-muted-foreground">—</span>}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={statusColor}>
                            {u.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {u.has_linked_record ? (
                            <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Linked</Badge>
                          ) : (
                            <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/20">Unlinked</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
