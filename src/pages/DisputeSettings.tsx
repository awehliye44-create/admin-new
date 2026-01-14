import { useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  Settings, 
  Clock, 
  Bell,
  AlertTriangle,
  Scale,
  Shield,
  Mail,
  RefreshCw,
  Save,
  Plus,
  Trash2,
  Edit
} from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';

interface DisputeConfig {
  general: {
    auto_assign_enabled: boolean;
    default_priority: string;
    response_sla_hours: number;
    resolution_sla_hours: number;
    escalation_threshold_hours: number;
    auto_close_resolved_days: number;
    allow_reopen_days: number;
  };
  notifications: {
    notify_on_new_dispute: boolean;
    notify_on_escalation: boolean;
    notify_on_resolution: boolean;
    notify_customer_on_update: boolean;
    notify_driver_on_dispute: boolean;
    escalation_email: string;
    admin_email: string;
  };
  automation: {
    auto_refund_threshold: number;
    auto_approve_duplicate_charges: boolean;
    auto_reject_late_disputes_days: number;
    require_evidence_for_rejection: boolean;
    min_dispute_amount: number;
  };
  categories: {
    id: string;
    name: string;
    description: string;
    priority: string;
    sla_hours: number;
    auto_assign_team: string;
    is_active: boolean;
  }[];
}

const defaultConfig: DisputeConfig = {
  general: {
    auto_assign_enabled: true,
    default_priority: 'medium',
    response_sla_hours: 24,
    resolution_sla_hours: 72,
    escalation_threshold_hours: 48,
    auto_close_resolved_days: 7,
    allow_reopen_days: 14,
  },
  notifications: {
    notify_on_new_dispute: true,
    notify_on_escalation: true,
    notify_on_resolution: true,
    notify_customer_on_update: true,
    notify_driver_on_dispute: false,
    escalation_email: 'escalations@company.com',
    admin_email: 'disputes@company.com',
  },
  automation: {
    auto_refund_threshold: 10,
    auto_approve_duplicate_charges: true,
    auto_reject_late_disputes_days: 30,
    require_evidence_for_rejection: true,
    min_dispute_amount: 1,
  },
  categories: [
    { id: '1', name: 'Fare Dispute', description: 'Disputes about fare amounts', priority: 'medium', sla_hours: 48, auto_assign_team: 'Billing Team', is_active: true },
    { id: '2', name: 'Refund Request', description: 'Requests for full or partial refunds', priority: 'high', sla_hours: 24, auto_assign_team: 'Support Team', is_active: true },
    { id: '3', name: 'Driver Complaint', description: 'Complaints about driver behavior', priority: 'high', sla_hours: 24, auto_assign_team: 'Safety Team', is_active: true },
    { id: '4', name: 'Billing Error', description: 'Errors in billing or charges', priority: 'high', sla_hours: 24, auto_assign_team: 'Billing Team', is_active: true },
    { id: '5', name: 'Service Issue', description: 'Issues with service quality', priority: 'medium', sla_hours: 48, auto_assign_team: 'Support Team', is_active: true },
  ],
};

export default function DisputeSettings() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('general');
  const [editingCategory, setEditingCategory] = useState<DisputeConfig['categories'][0] | null>(null);
  const [isAddingCategory, setIsAddingCategory] = useState(false);

  const { data: config = defaultConfig, isLoading } = useQuery({
    queryKey: ['dispute-settings'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('*')
        .eq('setting_key', 'dispute_settings')
        .maybeSingle();
      
      if (error) throw error;
      return (data?.setting_value as unknown as DisputeConfig) || defaultConfig;
    },
  });

  const [localConfig, setLocalConfig] = useState<DisputeConfig>(config);

  // Sync local state when data loads
  useState(() => {
    setLocalConfig(config);
  });

  const saveMutation = useMutation({
    mutationFn: async (newConfig: DisputeConfig) => {
      const { error } = await supabase
        .from('admin_settings')
        .upsert([{
          setting_key: 'dispute_settings',
          setting_value: JSON.parse(JSON.stringify(newConfig)),
          description: 'Dispute settings configuration',
          updated_at: new Date().toISOString(),
        }], { onConflict: 'setting_key' });
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dispute-settings'] });
      toast.success('Settings saved successfully');
    },
    onError: () => {
      toast.error('Failed to save settings');
    },
  });

  const handleSave = () => {
    saveMutation.mutate(localConfig);
  };

  const handleAddCategory = (category: Omit<DisputeConfig['categories'][0], 'id'>) => {
    const newCategory = { ...category, id: crypto.randomUUID() };
    setLocalConfig({
      ...localConfig,
      categories: [...localConfig.categories, newCategory],
    });
    setIsAddingCategory(false);
    toast.success('Category added');
  };

  const handleUpdateCategory = (category: DisputeConfig['categories'][0]) => {
    setLocalConfig({
      ...localConfig,
      categories: localConfig.categories.map(c => c.id === category.id ? category : c),
    });
    setEditingCategory(null);
    toast.success('Category updated');
  };

  const handleDeleteCategory = (id: string) => {
    setLocalConfig({
      ...localConfig,
      categories: localConfig.categories.filter(c => c.id !== id),
    });
    toast.success('Category deleted');
  };

  if (isLoading) {
    return (
      <AdminLayout title="Dispute Settings" description="Configure dispute handling">
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout 
      title="Dispute Settings" 
      description="Configure dispute handling rules and automation"
    >
      <div className="space-y-6">
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saveMutation.isPending}>
            <Save className="h-4 w-4 mr-2" />
            Save Changes
          </Button>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="general" className="flex items-center gap-2">
              <Settings className="h-4 w-4" />
              General
            </TabsTrigger>
            <TabsTrigger value="notifications" className="flex items-center gap-2">
              <Bell className="h-4 w-4" />
              Notifications
            </TabsTrigger>
            <TabsTrigger value="automation" className="flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Automation
            </TabsTrigger>
            <TabsTrigger value="categories" className="flex items-center gap-2">
              <Scale className="h-4 w-4" />
              Categories
            </TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>General Settings</CardTitle>
                <CardDescription>Configure basic dispute handling parameters</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Auto-Assign Disputes</Label>
                    <p className="text-sm text-muted-foreground">Automatically assign disputes to teams based on category</p>
                  </div>
                  <Switch
                    checked={localConfig.general.auto_assign_enabled}
                    onCheckedChange={(checked) => setLocalConfig({
                      ...localConfig,
                      general: { ...localConfig.general, auto_assign_enabled: checked }
                    })}
                  />
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Default Priority</Label>
                    <Select 
                      value={localConfig.general.default_priority}
                      onValueChange={(value) => setLocalConfig({
                        ...localConfig,
                        general: { ...localConfig.general, default_priority: value }
                      })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="low">Low</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                        <SelectItem value="urgent">Urgent</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Response SLA (hours)</Label>
                    <Input
                      type="number"
                      value={localConfig.general.response_sla_hours}
                      onChange={(e) => setLocalConfig({
                        ...localConfig,
                        general: { ...localConfig.general, response_sla_hours: parseInt(e.target.value) || 0 }
                      })}
                    />
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Resolution SLA (hours)</Label>
                    <Input
                      type="number"
                      value={localConfig.general.resolution_sla_hours}
                      onChange={(e) => setLocalConfig({
                        ...localConfig,
                        general: { ...localConfig.general, resolution_sla_hours: parseInt(e.target.value) || 0 }
                      })}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Escalation Threshold (hours)</Label>
                    <Input
                      type="number"
                      value={localConfig.general.escalation_threshold_hours}
                      onChange={(e) => setLocalConfig({
                        ...localConfig,
                        general: { ...localConfig.general, escalation_threshold_hours: parseInt(e.target.value) || 0 }
                      })}
                    />
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Auto-Close Resolved After (days)</Label>
                    <Input
                      type="number"
                      value={localConfig.general.auto_close_resolved_days}
                      onChange={(e) => setLocalConfig({
                        ...localConfig,
                        general: { ...localConfig.general, auto_close_resolved_days: parseInt(e.target.value) || 0 }
                      })}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Allow Reopen Within (days)</Label>
                    <Input
                      type="number"
                      value={localConfig.general.allow_reopen_days}
                      onChange={(e) => setLocalConfig({
                        ...localConfig,
                        general: { ...localConfig.general, allow_reopen_days: parseInt(e.target.value) || 0 }
                      })}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="notifications" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Notification Settings</CardTitle>
                <CardDescription>Configure when and who receives notifications</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>Notify on New Dispute</Label>
                      <p className="text-sm text-muted-foreground">Send notification when a new dispute is created</p>
                    </div>
                    <Switch
                      checked={localConfig.notifications.notify_on_new_dispute}
                      onCheckedChange={(checked) => setLocalConfig({
                        ...localConfig,
                        notifications: { ...localConfig.notifications, notify_on_new_dispute: checked }
                      })}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>Notify on Escalation</Label>
                      <p className="text-sm text-muted-foreground">Send notification when a dispute is escalated</p>
                    </div>
                    <Switch
                      checked={localConfig.notifications.notify_on_escalation}
                      onCheckedChange={(checked) => setLocalConfig({
                        ...localConfig,
                        notifications: { ...localConfig.notifications, notify_on_escalation: checked }
                      })}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>Notify on Resolution</Label>
                      <p className="text-sm text-muted-foreground">Send notification when a dispute is resolved</p>
                    </div>
                    <Switch
                      checked={localConfig.notifications.notify_on_resolution}
                      onCheckedChange={(checked) => setLocalConfig({
                        ...localConfig,
                        notifications: { ...localConfig.notifications, notify_on_resolution: checked }
                      })}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>Notify Customer on Updates</Label>
                      <p className="text-sm text-muted-foreground">Keep customers informed of dispute progress</p>
                    </div>
                    <Switch
                      checked={localConfig.notifications.notify_customer_on_update}
                      onCheckedChange={(checked) => setLocalConfig({
                        ...localConfig,
                        notifications: { ...localConfig.notifications, notify_customer_on_update: checked }
                      })}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>Notify Driver on Dispute</Label>
                      <p className="text-sm text-muted-foreground">Notify drivers when disputes are filed against them</p>
                    </div>
                    <Switch
                      checked={localConfig.notifications.notify_driver_on_dispute}
                      onCheckedChange={(checked) => setLocalConfig({
                        ...localConfig,
                        notifications: { ...localConfig.notifications, notify_driver_on_dispute: checked }
                      })}
                    />
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2 pt-4 border-t">
                  <div className="space-y-2">
                    <Label>Escalation Email</Label>
                    <Input
                      type="email"
                      value={localConfig.notifications.escalation_email}
                      onChange={(e) => setLocalConfig({
                        ...localConfig,
                        notifications: { ...localConfig.notifications, escalation_email: e.target.value }
                      })}
                      placeholder="escalations@company.com"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Admin Email</Label>
                    <Input
                      type="email"
                      value={localConfig.notifications.admin_email}
                      onChange={(e) => setLocalConfig({
                        ...localConfig,
                        notifications: { ...localConfig.notifications, admin_email: e.target.value }
                      })}
                      placeholder="disputes@company.com"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="automation" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Automation Rules</CardTitle>
                <CardDescription>Configure automatic dispute handling rules</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Auto-Refund Threshold ($)</Label>
                    <p className="text-xs text-muted-foreground">Automatically approve refunds below this amount</p>
                    <Input
                      type="number"
                      step="0.01"
                      value={localConfig.automation.auto_refund_threshold}
                      onChange={(e) => setLocalConfig({
                        ...localConfig,
                        automation: { ...localConfig.automation, auto_refund_threshold: parseFloat(e.target.value) || 0 }
                      })}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Minimum Dispute Amount ($)</Label>
                    <p className="text-xs text-muted-foreground">Reject disputes below this amount</p>
                    <Input
                      type="number"
                      step="0.01"
                      value={localConfig.automation.min_dispute_amount}
                      onChange={(e) => setLocalConfig({
                        ...localConfig,
                        automation: { ...localConfig.automation, min_dispute_amount: parseFloat(e.target.value) || 0 }
                      })}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Auto-Reject Late Disputes (days)</Label>
                  <p className="text-xs text-muted-foreground">Automatically reject disputes filed after this many days</p>
                  <Input
                    type="number"
                    value={localConfig.automation.auto_reject_late_disputes_days}
                    onChange={(e) => setLocalConfig({
                      ...localConfig,
                      automation: { ...localConfig.automation, auto_reject_late_disputes_days: parseInt(e.target.value) || 0 }
                    })}
                  />
                </div>

                <div className="space-y-4 pt-4 border-t">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>Auto-Approve Duplicate Charges</Label>
                      <p className="text-sm text-muted-foreground">Automatically refund verified duplicate charges</p>
                    </div>
                    <Switch
                      checked={localConfig.automation.auto_approve_duplicate_charges}
                      onCheckedChange={(checked) => setLocalConfig({
                        ...localConfig,
                        automation: { ...localConfig.automation, auto_approve_duplicate_charges: checked }
                      })}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>Require Evidence for Rejection</Label>
                      <p className="text-sm text-muted-foreground">Agents must provide evidence when rejecting disputes</p>
                    </div>
                    <Switch
                      checked={localConfig.automation.require_evidence_for_rejection}
                      onCheckedChange={(checked) => setLocalConfig({
                        ...localConfig,
                        automation: { ...localConfig.automation, require_evidence_for_rejection: checked }
                      })}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="categories" className="space-y-6">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Dispute Categories</CardTitle>
                  <CardDescription>Manage dispute types and their handling rules</CardDescription>
                </div>
                <Button onClick={() => setIsAddingCategory(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Category
                </Button>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Priority</TableHead>
                      <TableHead>SLA (hrs)</TableHead>
                      <TableHead>Team</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {localConfig.categories.map((category) => (
                      <TableRow key={category.id}>
                        <TableCell className="font-medium">{category.name}</TableCell>
                        <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                          {category.description}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{category.priority}</Badge>
                        </TableCell>
                        <TableCell>{category.sla_hours}</TableCell>
                        <TableCell>{category.auto_assign_team}</TableCell>
                        <TableCell>
                          <Badge variant={category.is_active ? 'default' : 'secondary'}>
                            {category.is_active ? 'Active' : 'Inactive'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button 
                              variant="ghost" 
                              size="sm"
                              onClick={() => setEditingCategory(category)}
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button 
                              variant="ghost" 
                              size="sm"
                              className="text-destructive"
                              onClick={() => handleDeleteCategory(category.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Add/Edit Category Dialog */}
        <CategoryDialog
          open={isAddingCategory || !!editingCategory}
          onOpenChange={() => { setIsAddingCategory(false); setEditingCategory(null); }}
          category={editingCategory}
          onSave={(category) => {
            if (editingCategory) {
              handleUpdateCategory({ ...category, id: editingCategory.id });
            } else {
              handleAddCategory(category);
            }
          }}
        />
      </div>
    </AdminLayout>
  );
}

interface CategoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  category: DisputeConfig['categories'][0] | null;
  onSave: (category: Omit<DisputeConfig['categories'][0], 'id'>) => void;
}

function CategoryDialog({ open, onOpenChange, category, onSave }: CategoryDialogProps) {
  const [formData, setFormData] = useState({
    name: category?.name || '',
    description: category?.description || '',
    priority: category?.priority || 'medium',
    sla_hours: category?.sla_hours || 24,
    auto_assign_team: category?.auto_assign_team || '',
    is_active: category?.is_active ?? true,
  });

  useState(() => {
    if (category) {
      setFormData({
        name: category.name,
        description: category.description,
        priority: category.priority,
        sla_hours: category.sla_hours,
        auto_assign_team: category.auto_assign_team,
        is_active: category.is_active,
      });
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{category ? 'Edit Category' : 'Add Category'}</DialogTitle>
          <DialogDescription>Configure dispute category settings</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="Category name"
            />
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="Category description"
              rows={2}
            />
          </div>
          <div className="grid gap-4 grid-cols-2">
            <div className="space-y-2">
              <Label>Priority</Label>
              <Select value={formData.priority} onValueChange={(value) => setFormData({ ...formData, priority: value })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>SLA (hours)</Label>
              <Input
                type="number"
                value={formData.sla_hours}
                onChange={(e) => setFormData({ ...formData, sla_hours: parseInt(e.target.value) || 0 })}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Auto-Assign Team</Label>
            <Input
              value={formData.auto_assign_team}
              onChange={(e) => setFormData({ ...formData, auto_assign_team: e.target.value })}
              placeholder="Team name"
            />
          </div>
          <div className="flex items-center justify-between">
            <Label>Active</Label>
            <Switch
              checked={formData.is_active}
              onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => onSave(formData)} disabled={!formData.name}>
            {category ? 'Update' : 'Add'} Category
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
