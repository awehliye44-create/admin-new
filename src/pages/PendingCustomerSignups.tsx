import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePageLoadTelemetry } from '@/hooks/useAdminTelemetry';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import {
  UserPlus, Loader2, Search, RefreshCw, Mail, Phone, Clock, AlertCircle,
} from 'lucide-react';
import { format, formatDistanceToNow, isPast } from 'date-fns';

interface PendingSignup {
  id: string;
  user_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  email_verified_at: string | null;
  phone_verified_at: string | null;
  status: string;
  signup_source: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  auth_email_confirmed_at: string | null;
  auth_phone_confirmed_at: string | null;
  record_type: string;
  legacy_customer_code: string | null;
}

type StatusFilter = 'all' | 'pending' | 'email_verified' | 'legacy_ghost';

export default function PendingCustomerSignups() {
  usePageLoadTelemetry('PendingCustomerSignupsPage');
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const { data: signups = [], isLoading, error } = useQuery({
    queryKey: ['pending-customer-signups'],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from('admin_pending_customer_signups' as 'admin_riders_with_trip_stats')
        .select(
          'id, user_id, first_name, last_name, email, phone, email_verified_at, phone_verified_at, status, signup_source, expires_at, created_at, updated_at, auth_email_confirmed_at, auth_phone_confirmed_at, record_type, legacy_customer_code',
        )
        .order('created_at', { ascending: false });

      if (queryError) throw queryError;
      return (data ?? []) as unknown as PendingSignup[];
    },
    staleTime: 30_000,
  });

  const refreshData = () => queryClient.invalidateQueries({ queryKey: ['pending-customer-signups'] });

  const getFullName = (row: PendingSignup) => {
    const name = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim();
    return name || 'Unknown';
  };

  const getInitials = (row: PendingSignup) => {
    const first = row.first_name?.charAt(0)?.toUpperCase() ?? '';
    const last = row.last_name?.charAt(0)?.toUpperCase() ?? '';
    return first + last || '?';
  };

  const getStatusBadge = (row: PendingSignup) => {
    if (row.record_type === 'legacy_ghost' || row.status === 'legacy_ghost') {
      return <Badge className="bg-amber-500/10 text-amber-700 border-amber-500/30">Legacy ghost</Badge>;
    }
    if (row.status === 'email_verified') {
      return <Badge className="bg-blue-500/10 text-blue-600 border-blue-500/30">Email verified</Badge>;
    }
    return <Badge className="bg-slate-500/10 text-slate-600 border-slate-500/30">Pending email</Badge>;
  };

  const filtered = signups.filter((row) => {
    const query = searchQuery.toLowerCase();
    const name = getFullName(row).toLowerCase();
    const email = row.email?.toLowerCase() ?? '';
    const phone = row.phone?.toLowerCase() ?? '';
    const legacy = row.legacy_customer_code?.toLowerCase() ?? '';
    const matchesSearch = !query || name.includes(query) || email.includes(query) || phone.includes(query) || legacy.includes(query);

    const matchesStatus =
      statusFilter === 'all'
      || (statusFilter === 'legacy_ghost' && (row.record_type === 'legacy_ghost' || row.status === 'legacy_ghost'))
      || (statusFilter !== 'legacy_ghost' && row.status === statusFilter);

    return matchesSearch && matchesStatus;
  });

  const counts = {
    all: signups.length,
    pending: signups.filter((r) => r.status === 'pending').length,
    email_verified: signups.filter((r) => r.status === 'email_verified').length,
    legacy_ghost: signups.filter((r) => r.record_type === 'legacy_ghost' || r.status === 'legacy_ghost').length,
  };

  return (
    <AdminLayout
      title="Pending Customer Signups"
      description="Incomplete customer onboarding — not active rider accounts until email and phone are verified"
    >
      <div className="mb-4 rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3 text-sm text-muted-foreground">
        These users have started signup but do not have an activated rider profile yet.
        {' '}
        <Link to="/riders" className="font-medium text-primary underline-offset-2 hover:underline">
          Rider List
        </Link>
        {' '}
        shows only completed, active customers.
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Total incomplete</p>
            <p className="text-2xl font-bold">{counts.all}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Awaiting email</p>
            <p className="text-2xl font-bold text-slate-600">{counts.pending}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Awaiting phone OTP</p>
            <p className="text-2xl font-bold text-blue-600">{counts.email_verified}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Legacy ghosts</p>
            <p className="text-2xl font-bold text-amber-600">{counts.legacy_ghost}</p>
          </CardContent>
        </Card>
      </div>

      <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)} className="mb-4">
        <TabsList>
          <TabsTrigger value="all">All ({counts.all})</TabsTrigger>
          <TabsTrigger value="pending">Pending email ({counts.pending})</TabsTrigger>
          <TabsTrigger value="email_verified">Email done ({counts.email_verified})</TabsTrigger>
          <TabsTrigger value="legacy_ghost">Legacy ({counts.legacy_ghost})</TabsTrigger>
        </TabsList>
      </Tabs>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <UserPlus className="h-5 w-5 text-primary" />
                Pending signups
              </CardTitle>
              <CardDescription>{filtered.length} incomplete signups</CardDescription>
            </div>
            <div className="flex items-center gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search name, email, phone..."
                  className="pl-9 w-[260px]"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <Button variant="outline" size="icon" onClick={refreshData}>
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="flex items-center gap-2 text-destructive py-8 justify-center">
              <AlertCircle className="h-5 w-5" />
              <span>{error instanceof Error ? error.message : 'Failed to load pending signups'}</span>
            </div>
          ) : isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              {searchQuery ? 'No signups match your search' : 'No pending customer signups'}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Started</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((row) => (
                  <TableRow key={`${row.record_type}-${row.id}`}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar className="h-9 w-9">
                          <AvatarFallback className="bg-primary/10 text-primary text-sm">
                            {getInitials(row)}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="font-medium">{getFullName(row)}</p>
                          {row.legacy_customer_code ? (
                            <p className="text-xs text-muted-foreground font-mono">was {row.legacy_customer_code}</p>
                          ) : null}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 text-sm">
                        <Mail className="h-3 w-3 text-muted-foreground" />
                        <span>{row.email ?? '—'}</span>
                        {(row.auth_email_confirmed_at || row.email_verified_at) && (
                          <Badge variant="outline" className="text-xs ml-1">✓</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 text-sm">
                        <Phone className="h-3 w-3 text-muted-foreground" />
                        <span>{row.phone ?? '—'}</span>
                        {(row.auth_phone_confirmed_at || row.phone_verified_at) && (
                          <Badge variant="outline" className="text-xs ml-1">✓</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{getStatusBadge(row)}</TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">{row.signup_source ?? '—'}</span>
                    </TableCell>
                    <TableCell>
                      {row.expires_at ? (
                        <span className={`text-sm ${isPast(new Date(row.expires_at)) ? 'text-destructive' : 'text-muted-foreground'}`}>
                          {formatDistanceToNow(new Date(row.expires_at), { addSuffix: true })}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 text-sm text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {format(new Date(row.created_at), 'MMM d, yyyy')}
                      </div>
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
