import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Copy, Edit, Lock, Plus, Trash2, Loader2 } from 'lucide-react';
import type { StaffRole } from '@/hooks/useStaffProfile';
import { ROLE_LABELS } from '@/hooks/useStaffProfile';
import type { CatalogRole } from '@/pages/RolesPermissions';

const BASE_LEVELS: StaffRole[] = ['admin', 'operator', 'finance_manager', 'customer_support', 'compliance_officer'];

interface Props {
  roles: CatalogRole[];
  staffCountByRole: Record<string, number>;
  pageCountByRole: Record<string, number>;
  actionCountByRole: Record<string, number>;
  canManage: boolean;
  onChanged: () => Promise<void> | void;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
}

type Mode = { kind: 'create'; copyFrom?: CatalogRole } | { kind: 'edit'; role: CatalogRole };

export function RolesCatalogManager({
  roles, staffCountByRole, pageCountByRole, actionCountByRole, canManage, onChanged, onError, onSuccess,
}: Props) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [baseRole, setBaseRole] = useState<StaffRole>('operator');
  const [isActive, setIsActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<CatalogRole | null>(null);

  const open = (m: Mode) => {
    setMode(m);
    if (m.kind === 'edit') {
      setName(m.role.name);
      setDescription(m.role.description ?? '');
      setBaseRole(m.role.base_role);
      setIsActive(m.role.is_active);
    } else {
      setName(m.copyFrom ? `${m.copyFrom.name} (copy)` : '');
      setDescription(m.copyFrom?.description ?? '');
      setBaseRole(m.copyFrom && m.copyFrom.base_role !== 'super_admin' ? m.copyFrom.base_role : 'operator');
      setIsActive(true);
    }
  };

  const save = async () => {
    if (!mode) return;
    if (name.trim().length < 2) {
      onError('Role name must be at least 2 characters');
      return;
    }
    setBusy(true);
    const { error } = await supabase.rpc('admin_save_staff_role', {
      _role_id: mode.kind === 'edit' ? mode.role.id : null,
      _name: name.trim(),
      _description: description.trim(),
      _base_role: baseRole,
      _is_active: isActive,
      _copy_from_role_id: mode.kind === 'create' ? mode.copyFrom?.id ?? null : null,
    } as never);
    setBusy(false);
    if (error) {
      onError(error.message.includes('staff_roles_catalog_name_uq') ? 'A role with this name already exists' : error.message);
      return;
    }
    onSuccess(mode.kind === 'edit' ? `Role "${name.trim()}" updated` : `Role "${name.trim()}" created`);
    setMode(null);
    await onChanged();
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    const { error } = await supabase.rpc('admin_delete_staff_role', { _role_id: deleting.id } as never);
    setBusy(false);
    if (error) {
      onError(error.message);
      return;
    }
    onSuccess(`Role "${deleting.name}" deleted`);
    setDeleting(null);
    await onChanged();
  };

  return (
    <Card className="mb-6">
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle>Roles</CardTitle>
          <CardDescription>
            Create your own roles, then choose their pages and actions below. A new role starts with no access unless you copy one.
          </CardDescription>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => open({ kind: 'create' })}>
            <Plus className="h-4 w-4 mr-2" />
            New Role
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead>Access level</TableHead>
                <TableHead className="text-center">Staff</TableHead>
                <TableHead className="text-center">Pages</TableHead>
                <TableHead className="text-center">Actions</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {roles.map(role => {
                const staffCount = staffCountByRole[role.id] ?? 0;
                return (
                  <TableRow key={role.id}>
                    <TableCell>
                      <div className="font-medium flex items-center gap-1">
                        {role.is_owner_role && <Lock className="h-3 w-3 text-primary" />}
                        {role.name}
                      </div>
                      {role.description && <p className="text-xs text-muted-foreground max-w-[280px]">{role.description}</p>}
                    </TableCell>
                    <TableCell className="text-sm">{ROLE_LABELS[role.base_role]}</TableCell>
                    <TableCell className="text-center">{staffCount}</TableCell>
                    <TableCell className="text-center">{role.is_owner_role ? 'All' : pageCountByRole[role.id] ?? 0}</TableCell>
                    <TableCell className="text-center">{role.is_owner_role ? 'All' : actionCountByRole[role.id] ?? 0}</TableCell>
                    <TableCell>
                      {role.is_owner_role ? (
                        <Badge variant="outline">Protected</Badge>
                      ) : role.is_active ? (
                        <Badge variant="secondary">Active</Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground">Inactive</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage && (
                        <div className="flex justify-end gap-1">
                          {!role.is_owner_role && (
                            <>
                              <Button variant="ghost" size="icon" title="Duplicate" onClick={() => open({ kind: 'create', copyFrom: role })}>
                                <Copy className="h-4 w-4" />
                              </Button>
                              <Button variant="ghost" size="icon" title="Edit" onClick={() => open({ kind: 'edit', role })}>
                                <Edit className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="text-destructive"
                                disabled={staffCount > 0}
                                title={staffCount > 0 ? 'Move staff off this role before deleting it' : 'Delete'}
                                onClick={() => setDeleting(role)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </>
                          )}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      <Dialog open={!!mode} onOpenChange={(o) => !o && setMode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{mode?.kind === 'edit' ? 'Edit Role' : mode?.copyFrom ? `Duplicate ${mode.copyFrom.name}` : 'New Role'}</DialogTitle>
            <DialogDescription>
              {mode?.kind === 'create' && mode.copyFrom
                ? 'The new role copies the pages and actions you are allowed to give.'
                : 'The new role starts with no pages or actions. Turn them on in the tables below.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Night Dispatcher" />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Access level</Label>
              <Select value={baseRole} onValueChange={(v) => setBaseRole(v as StaffRole)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {BASE_LEVELS.map(l => <SelectItem key={l} value={l}>{ROLE_LABELS[l]}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Sets the Staff ID prefix and is used by a few older finance checks. Pages and actions below decide what this role can do.
              </p>
            </div>
            {mode?.kind === 'edit' && (
              <div className="flex items-center justify-between">
                <Label>Active</Label>
                <Switch checked={isActive} onCheckedChange={setIsActive} />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMode(null)}>Cancel</Button>
            <Button onClick={save} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleting?.name}?</DialogTitle>
            <DialogDescription>This permanently removes the role and its permissions.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="destructive" onClick={remove} disabled={busy}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
