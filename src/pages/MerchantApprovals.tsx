import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { MoreHorizontal, Search, ShieldCheck } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { useServiceAreas } from '@/hooks/useServiceAreas';

type Category = 'food' | 'grocery' | 'retail' | 'pharmacy' | 'parcel';
type Status = 'pending' | 'approved' | 'rejected' | 'disabled' | 'suspended';

const CATEGORY_LABEL: Record<Category, string> = {
  food: 'Restaurant',
  grocery: 'Grocery',
  retail: 'Retail',
  pharmacy: 'Pharmacy',
  parcel: 'Parcel',
};

interface Merchant {
  id: string;
  business_name: string;
  category: Category;
  service_area_id: string;
  owner_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  postcode: string | null;
  description: string | null;
  logo_url: string | null;
  banner_url: string | null;
  opening_hours: any;
  prep_time_minutes: number | null;
  delivery_radius_km: number | null;
  status: Status;
  admin_notes: string | null;
  rejection_reason: string | null;
  created_at: string;
}

export default function MerchantApprovals() {
  const { data: serviceAreas } = useServiceAreas();
  const [rows, setRows] = useState<Merchant[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('pending');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [saFilter, setSaFilter] = useState<string>('all');
  const [viewing, setViewing] = useState<Merchant | null>(null);
  const [adminNotes, setAdminNotes] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('merchants')
      .select('*')
      .order('created_at', { ascending: false });
    setLoading(false);
    if (error) return toast({ title: 'Failed to load', description: error.message, variant: 'destructive' });
    setRows((data as any) ?? []);
  };

  useEffect(() => { load(); }, []);

  const saName = (id: string) => serviceAreas?.find((s) => s.id === id)?.name ?? '—';

  const filtered = rows.filter((m) => {
    if (search && !m.business_name.toLowerCase().includes(search.toLowerCase())) return false;
    if (statusFilter !== 'all' && m.status !== statusFilter) return false;
    if (categoryFilter !== 'all' && m.category !== categoryFilter) return false;
    if (saFilter !== 'all' && m.service_area_id !== saFilter) return false;
    return true;
  });

  const counts = {
    pending: rows.filter((r) => r.status === 'pending').length,
    approved: rows.filter((r) => r.status === 'approved').length,
    rejected: rows.filter((r) => r.status === 'rejected').length,
    disabled: rows.filter((r) => r.status === 'disabled').length,
    suspended: rows.filter((r) => r.status === 'suspended').length,
  };

  const updateStatus = async (id: string, status: Status, extra: Partial<Merchant> = {}) => {
    const { error } = await supabase
      .from('merchants')
      .update({ status: status as any, ...extra })
      .eq('id', id);
    if (error) return toast({ title: 'Failed', description: error.message, variant: 'destructive' });
    toast({ title: 'Updated', description: `Merchant ${status}` });
    setViewing(null);
    load();
  };

  const openView = (m: Merchant) => {
    setViewing(m);
    setAdminNotes(m.admin_notes ?? '');
    setRejectionReason(m.rejection_reason ?? '');
  };

  const saveNotes = async () => {
    if (!viewing) return;
    const { error } = await supabase
      .from('merchants')
      .update({ admin_notes: adminNotes, rejection_reason: rejectionReason })
      .eq('id', viewing.id);
    if (error) return toast({ title: 'Failed', description: error.message, variant: 'destructive' });
    toast({ title: 'Notes saved' });
    load();
  };

  const statusBadge = (s: Status) => {
    const map: Record<Status, string> = {
      approved: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40',
      pending: 'bg-amber-500/20 text-amber-400 border-amber-500/40',
      rejected: 'bg-rose-500/20 text-rose-400 border-rose-500/40',
      suspended: 'bg-rose-500/20 text-rose-400 border-rose-500/40',
      disabled: 'bg-muted text-muted-foreground border-muted',
    };
    const label: Record<Status, string> = {
      pending: 'Pending Approval',
      approved: 'Approved',
      rejected: 'Rejected',
      disabled: 'Disabled',
      suspended: 'Suspended',
    };
    return <Badge variant="outline" className={map[s]}>{label[s]}</Badge>;
  };

  return (
    <AdminLayout title="Merchant Approvals" description="Review and control marketplace merchant signups before they go live">
      <div className="space-y-6 p-6">
        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {(['pending','approved','rejected','disabled','suspended'] as Status[]).map((s) => (
            <Card key={s}>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground capitalize">{s}</div>
                <div className="text-2xl font-semibold text-primary">{counts[s]}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5" /> Applications</CardTitle>
            <CardDescription>
              Approve, reject, disable or suspend merchant accounts. Only Approved merchants appear in the customer app (subject to service-area toggles).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input className="pl-9" placeholder="Search business name…" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="pending">Pending Approval</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                  <SelectItem value="disabled">Disabled</SelectItem>
                  <SelectItem value="suspended">Suspended</SelectItem>
                </SelectContent>
              </Select>
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
                    <SelectItem key={c} value={c}>{CATEGORY_LABEL[c]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={saFilter} onValueChange={setSaFilter}>
                <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All service areas</SelectItem>
                  {serviceAreas?.map((sa) => <SelectItem key={sa.id} value={sa.id}>{sa.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="rounded-md border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Business</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Service area</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Submitted</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 && (
                    <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                      {loading ? 'Loading…' : 'No applications match the current filters'}
                    </TableCell></TableRow>
                  )}
                  {filtered.map((m) => (
                    <TableRow key={m.id} className="cursor-pointer" onClick={() => openView(m)}>
                      <TableCell className="font-medium">{m.business_name}</TableCell>
                      <TableCell>{CATEGORY_LABEL[m.category]}</TableCell>
                      <TableCell>{saName(m.service_area_id)}</TableCell>
                      <TableCell>{m.owner_name ?? '—'}</TableCell>
                      <TableCell className="text-xs">{m.email ?? '—'}</TableCell>
                      <TableCell className="text-xs">{m.phone ?? '—'}</TableCell>
                      <TableCell>{statusBadge(m.status)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{new Date(m.created_at).toLocaleDateString()}</TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openView(m)}>View application</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {m.status !== 'approved' && <DropdownMenuItem onClick={() => updateStatus(m.id, 'approved')}>Approve</DropdownMenuItem>}
                            {m.status !== 'rejected' && <DropdownMenuItem onClick={() => updateStatus(m.id, 'rejected')}>Reject</DropdownMenuItem>}
                            {m.status !== 'disabled' && <DropdownMenuItem onClick={() => updateStatus(m.id, 'disabled')}>Disable</DropdownMenuItem>}
                            {m.status !== 'suspended' && <DropdownMenuItem onClick={() => updateStatus(m.id, 'suspended')}>Suspend</DropdownMenuItem>}
                            {(m.status === 'disabled' || m.status === 'suspended' || m.status === 'rejected') && (
                              <DropdownMenuItem onClick={() => updateStatus(m.id, 'approved')}>Re-enable</DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* View Application Dialog */}
      <Dialog open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          {viewing && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-3">
                  {viewing.business_name}
                  {statusBadge(viewing.status)}
                </DialogTitle>
                <DialogDescription>Submitted {new Date(viewing.created_at).toLocaleString()}</DialogDescription>
              </DialogHeader>

              <div className="space-y-6">
                {/* Media */}
                {(viewing.logo_url || viewing.banner_url) && (
                  <div className="grid grid-cols-2 gap-3">
                    {viewing.logo_url && (
                      <div>
                        <Label className="text-xs text-muted-foreground">Logo</Label>
                        <img src={viewing.logo_url} alt="Logo" className="mt-1 h-24 w-24 rounded-lg object-cover border" />
                      </div>
                    )}
                    {viewing.banner_url && (
                      <div>
                        <Label className="text-xs text-muted-foreground">Banner</Label>
                        <img src={viewing.banner_url} alt="Banner" className="mt-1 h-24 w-full rounded-lg object-cover border" />
                      </div>
                    )}
                  </div>
                )}

                {/* Business Details */}
                <section>
                  <h3 className="font-semibold mb-2">Business Details</h3>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <Field label="Business name" value={viewing.business_name} />
                    <Field label="Merchant type" value={CATEGORY_LABEL[viewing.category]} />
                    <Field label="Service area" value={saName(viewing.service_area_id)} />
                    <Field label="Postcode" value={viewing.postcode} />
                    <div className="col-span-2"><Field label="Address" value={viewing.address} /></div>
                    <div className="col-span-2"><Field label="Description" value={viewing.description} /></div>
                  </div>
                </section>

                {/* Owner Details */}
                <section>
                  <h3 className="font-semibold mb-2">Owner / Contact</h3>
                  <div className="grid grid-cols-3 gap-3 text-sm">
                    <Field label="Owner name" value={viewing.owner_name} />
                    <Field label="Email" value={viewing.email} />
                    <Field label="Phone" value={viewing.phone} />
                  </div>
                </section>

                {/* Operating Details */}
                <section>
                  <h3 className="font-semibold mb-2">Operating Details</h3>
                  <div className="grid grid-cols-3 gap-3 text-sm">
                    <Field label="Prep time (min)" value={viewing.prep_time_minutes?.toString() ?? '—'} />
                    <Field label="Delivery radius (km)" value={viewing.delivery_radius_km?.toString() ?? '—'} />
                    <Field label="Opening hours" value={viewing.opening_hours ? 'Configured' : 'Not set'} />
                  </div>
                </section>

                {/* Admin Notes */}
                <section className="space-y-2">
                  <h3 className="font-semibold">Admin Notes</h3>
                  <Textarea value={adminNotes} onChange={(e) => setAdminNotes(e.target.value)} placeholder="Internal notes (not visible to merchant)…" rows={3} />
                  <Label className="text-xs text-muted-foreground mt-2 block">Rejection reason (shown to merchant if rejected)</Label>
                  <Textarea value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} placeholder="Reason for rejection…" rows={2} />
                  <Button variant="outline" size="sm" onClick={saveNotes}>Save notes</Button>
                </section>
              </div>

              <DialogFooter className="flex-wrap gap-2">
                {viewing.status !== 'approved' && (
                  <Button onClick={() => updateStatus(viewing.id, 'approved', { admin_notes: adminNotes })} className="bg-emerald-600 hover:bg-emerald-700">Approve</Button>
                )}
                {viewing.status !== 'rejected' && (
                  <Button variant="destructive" onClick={() => updateStatus(viewing.id, 'rejected', { admin_notes: adminNotes, rejection_reason: rejectionReason })}>Reject</Button>
                )}
                {viewing.status !== 'disabled' && (
                  <Button variant="outline" onClick={() => updateStatus(viewing.id, 'disabled', { admin_notes: adminNotes })}>Disable</Button>
                )}
                {viewing.status !== 'suspended' && (
                  <Button variant="outline" onClick={() => updateStatus(viewing.id, 'suspended', { admin_notes: adminNotes })}>Suspend</Button>
                )}
                {(viewing.status === 'disabled' || viewing.status === 'suspended' || viewing.status === 'rejected') && (
                  <Button onClick={() => updateStatus(viewing.id, 'approved', { admin_notes: adminNotes })}>Re-enable</Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="mt-0.5">{value || '—'}</div>
    </div>
  );
}
