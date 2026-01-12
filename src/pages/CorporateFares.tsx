import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AdminLayout } from "@/components/layout/AdminLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Plus, Edit, Trash2, Building2, CircleDollarSign, Search, Filter, Percent, DollarSign, Shield, Calendar, Clock } from "lucide-react";
import { format } from "date-fns";

interface CorporateFareRule {
  id: string;
  name: string;
  description: string | null;
  corporate_account_id: string | null;
  rule_type: string;
  discount_percentage: number | null;
  fixed_rate: number | null;
  fare_cap: number | null;
  applies_to_vehicle_types: string[] | null;
  applies_to_regions: string[] | null;
  time_restrictions: any;
  booking_restrictions: any;
  priority: number | null;
  is_active: boolean;
  valid_from: string | null;
  valid_until: string | null;
  created_at: string;
  updated_at: string;
}

interface VehicleType {
  id: string;
  name: string;
  slug: string;
}

interface Region {
  id: string;
  name: string;
}

const RULE_TYPES = [
  { value: 'discount', label: 'Percentage Discount', icon: Percent, description: 'Apply a percentage off the fare' },
  { value: 'fixed_rate', label: 'Fixed Rate', icon: DollarSign, description: 'Use a fixed rate per mile/km' },
  { value: 'cap', label: 'Fare Cap', icon: Shield, description: 'Maximum fare amount' },
];

export default function CorporateFares() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<CorporateFareRule | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    rule_type: "discount",
    discount_percentage: 10,
    fixed_rate: null as number | null,
    fare_cap: null as number | null,
    applies_to_vehicle_types: [] as string[],
    applies_to_regions: [] as string[],
    time_restrictions: null as any,
    booking_restrictions: {
      min_passengers: 1,
      max_passengers: null as number | null,
      advance_booking_hours: null as number | null,
    },
    priority: 0,
    is_active: true,
    valid_from: format(new Date(), "yyyy-MM-dd'T'HH:mm"),
    valid_until: "",
  });

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ['corporate-fare-rules'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('corporate_fare_rules')
        .select('*')
        .order('priority', { ascending: false });
      if (error) throw error;
      return data as CorporateFareRule[];
    },
  });

  const { data: vehicleTypes = [] } = useQuery({
    queryKey: ['vehicle-types'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('vehicle_types')
        .select('id, name, slug')
        .eq('is_active', true)
        .order('display_order');
      if (error) throw error;
      return data as VehicleType[];
    },
  });

  const { data: regions = [] } = useQuery({
    queryKey: ['regions'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('regions')
        .select('id, name')
        .order('name');
      if (error) throw error;
      return data as Region[];
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      const { error } = await supabase.from('corporate_fare_rules').insert({
        name: data.name,
        description: data.description || null,
        rule_type: data.rule_type,
        discount_percentage: data.rule_type === 'discount' ? data.discount_percentage : null,
        fixed_rate: data.rule_type === 'fixed_rate' ? data.fixed_rate : null,
        fare_cap: data.rule_type === 'cap' ? data.fare_cap : null,
        applies_to_vehicle_types: data.applies_to_vehicle_types.length > 0 ? data.applies_to_vehicle_types : null,
        applies_to_regions: data.applies_to_regions.length > 0 ? data.applies_to_regions : null,
        booking_restrictions: data.booking_restrictions,
        priority: data.priority,
        is_active: data.is_active,
        valid_from: data.valid_from || null,
        valid_until: data.valid_until || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['corporate-fare-rules'] });
      toast({ title: "Corporate fare rule created successfully" });
      resetForm();
    },
    onError: (error: any) => {
      toast({ title: "Failed to create rule", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: typeof formData }) => {
      const { error } = await supabase.from('corporate_fare_rules').update({
        name: data.name,
        description: data.description || null,
        rule_type: data.rule_type,
        discount_percentage: data.rule_type === 'discount' ? data.discount_percentage : null,
        fixed_rate: data.rule_type === 'fixed_rate' ? data.fixed_rate : null,
        fare_cap: data.rule_type === 'cap' ? data.fare_cap : null,
        applies_to_vehicle_types: data.applies_to_vehicle_types.length > 0 ? data.applies_to_vehicle_types : null,
        applies_to_regions: data.applies_to_regions.length > 0 ? data.applies_to_regions : null,
        booking_restrictions: data.booking_restrictions,
        priority: data.priority,
        is_active: data.is_active,
        valid_from: data.valid_from || null,
        valid_until: data.valid_until || null,
      }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['corporate-fare-rules'] });
      toast({ title: "Corporate fare rule updated successfully" });
      resetForm();
    },
    onError: (error: any) => {
      toast({ title: "Failed to update rule", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('corporate_fare_rules').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['corporate-fare-rules'] });
      toast({ title: "Corporate fare rule deleted successfully" });
    },
    onError: (error: any) => {
      toast({ title: "Failed to delete rule", description: error.message, variant: "destructive" });
    },
  });

  const toggleStatusMutation = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase.from('corporate_fare_rules').update({ is_active }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['corporate-fare-rules'] });
      toast({ title: "Rule status updated" });
    },
  });

  const resetForm = () => {
    setFormData({
      name: "",
      description: "",
      rule_type: "discount",
      discount_percentage: 10,
      fixed_rate: null,
      fare_cap: null,
      applies_to_vehicle_types: [],
      applies_to_regions: [],
      time_restrictions: null,
      booking_restrictions: {
        min_passengers: 1,
        max_passengers: null,
        advance_booking_hours: null,
      },
      priority: 0,
      is_active: true,
      valid_from: format(new Date(), "yyyy-MM-dd'T'HH:mm"),
      valid_until: "",
    });
    setEditingRule(null);
    setIsDialogOpen(false);
  };

  const handleEdit = (rule: CorporateFareRule) => {
    setEditingRule(rule);
    setFormData({
      name: rule.name,
      description: rule.description || "",
      rule_type: rule.rule_type,
      discount_percentage: rule.discount_percentage || 10,
      fixed_rate: rule.fixed_rate,
      fare_cap: rule.fare_cap,
      applies_to_vehicle_types: rule.applies_to_vehicle_types || [],
      applies_to_regions: rule.applies_to_regions || [],
      time_restrictions: rule.time_restrictions,
      booking_restrictions: rule.booking_restrictions || {
        min_passengers: 1,
        max_passengers: null,
        advance_booking_hours: null,
      },
      priority: rule.priority || 0,
      is_active: rule.is_active,
      valid_from: rule.valid_from ? format(new Date(rule.valid_from), "yyyy-MM-dd'T'HH:mm") : "",
      valid_until: rule.valid_until ? format(new Date(rule.valid_until), "yyyy-MM-dd'T'HH:mm") : "",
    });
    setIsDialogOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingRule) {
      updateMutation.mutate({ id: editingRule.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const getRuleTypeInfo = (type: string) => {
    return RULE_TYPES.find(t => t.value === type) || RULE_TYPES[0];
  };

  const formatRuleValue = (rule: CorporateFareRule) => {
    switch (rule.rule_type) {
      case 'discount':
        return `${rule.discount_percentage}% off`;
      case 'fixed_rate':
        return `£${rule.fixed_rate?.toFixed(2)}/mi`;
      case 'cap':
        return `Max £${rule.fare_cap?.toFixed(2)}`;
      default:
        return '-';
    }
  };

  const isRuleValid = (rule: CorporateFareRule) => {
    const now = new Date();
    if (rule.valid_from && new Date(rule.valid_from) > now) return 'upcoming';
    if (rule.valid_until && new Date(rule.valid_until) < now) return 'expired';
    return 'valid';
  };

  const toggleVehicleType = (typeSlug: string) => {
    const current = formData.applies_to_vehicle_types;
    const newTypes = current.includes(typeSlug)
      ? current.filter(t => t !== typeSlug)
      : [...current, typeSlug];
    setFormData({ ...formData, applies_to_vehicle_types: newTypes });
  };

  const toggleRegion = (regionId: string) => {
    const current = formData.applies_to_regions;
    const newRegions = current.includes(regionId)
      ? current.filter(r => r !== regionId)
      : [...current, regionId];
    setFormData({ ...formData, applies_to_regions: newRegions });
  };

  const filteredRules = rules.filter(rule => {
    const matchesSearch = rule.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (rule.description?.toLowerCase().includes(searchQuery.toLowerCase()));
    const matchesType = typeFilter === "all" || rule.rule_type === typeFilter;
    const matchesStatus = statusFilter === "all" || 
      (statusFilter === "active" && rule.is_active) ||
      (statusFilter === "inactive" && !rule.is_active);
    return matchesSearch && matchesType && matchesStatus;
  });

  const stats = {
    total: rules.length,
    active: rules.filter(r => r.is_active).length,
    discounts: rules.filter(r => r.rule_type === 'discount').length,
    expired: rules.filter(r => isRuleValid(r) === 'expired').length,
  };

  return (
    <AdminLayout title="Corporate Fare Rules">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Corporate Fare Rules</h1>
            <p className="text-muted-foreground">Configure special pricing for corporate accounts</p>
          </div>
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button onClick={() => resetForm()}>
                <Plus className="mr-2 h-4 w-4" />
                Add Fare Rule
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <form onSubmit={handleSubmit}>
                <DialogHeader>
                  <DialogTitle>{editingRule ? "Edit Fare Rule" : "Create Fare Rule"}</DialogTitle>
                  <DialogDescription>
                    Define special pricing rules for corporate clients
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4 max-h-[60vh] overflow-y-auto">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="name">Rule Name *</Label>
                      <Input
                        id="name"
                        value={formData.name}
                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                        placeholder="e.g., Enterprise Discount"
                        required
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label>Priority</Label>
                      <Input
                        type="number"
                        value={formData.priority}
                        onChange={(e) => setFormData({ ...formData, priority: parseInt(e.target.value) || 0 })}
                        min={0}
                        max={100}
                      />
                    </div>
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="description">Description</Label>
                    <Textarea
                      id="description"
                      value={formData.description}
                      onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                      placeholder="Describe this fare rule..."
                      rows={2}
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label>Rule Type *</Label>
                    <div className="grid grid-cols-3 gap-3">
                      {RULE_TYPES.map((type) => (
                        <button
                          key={type.value}
                          type="button"
                          className={`flex flex-col items-center gap-2 rounded-lg border p-4 text-center transition-colors ${
                            formData.rule_type === type.value
                              ? 'border-primary bg-primary/10'
                              : 'border-border hover:bg-accent'
                          }`}
                          onClick={() => setFormData({ ...formData, rule_type: type.value })}
                        >
                          <type.icon className="h-6 w-6" />
                          <span className="font-medium text-sm">{type.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {formData.rule_type === 'discount' && (
                    <div className="grid gap-2">
                      <Label>Discount Percentage</Label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          value={formData.discount_percentage}
                          onChange={(e) => setFormData({ ...formData, discount_percentage: parseFloat(e.target.value) || 0 })}
                          min={0}
                          max={100}
                          className="max-w-[120px]"
                        />
                        <span className="text-muted-foreground">%</span>
                      </div>
                    </div>
                  )}

                  {formData.rule_type === 'fixed_rate' && (
                    <div className="grid gap-2">
                      <Label>Fixed Rate (per mile)</Label>
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">£</span>
                        <Input
                          type="number"
                          step="0.01"
                          value={formData.fixed_rate || ""}
                          onChange={(e) => setFormData({ ...formData, fixed_rate: parseFloat(e.target.value) || null })}
                          className="max-w-[120px]"
                        />
                      </div>
                    </div>
                  )}

                  {formData.rule_type === 'cap' && (
                    <div className="grid gap-2">
                      <Label>Maximum Fare</Label>
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">£</span>
                        <Input
                          type="number"
                          step="0.01"
                          value={formData.fare_cap || ""}
                          onChange={(e) => setFormData({ ...formData, fare_cap: parseFloat(e.target.value) || null })}
                          className="max-w-[120px]"
                        />
                      </div>
                    </div>
                  )}

                  <div className="grid gap-2">
                    <Label>Applies to Vehicle Types</Label>
                    <div className="flex flex-wrap gap-2">
                      {vehicleTypes.map((type) => (
                        <Button
                          key={type.id}
                          type="button"
                          variant={formData.applies_to_vehicle_types.includes(type.slug) ? "default" : "outline"}
                          size="sm"
                          onClick={() => toggleVehicleType(type.slug)}
                        >
                          {type.name}
                        </Button>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">Leave empty to apply to all vehicle types</p>
                  </div>

                  <div className="grid gap-2">
                    <Label>Applies to Regions</Label>
                    <div className="flex flex-wrap gap-2">
                      {regions.map((region) => (
                        <Button
                          key={region.id}
                          type="button"
                          variant={formData.applies_to_regions.includes(region.id) ? "default" : "outline"}
                          size="sm"
                          onClick={() => toggleRegion(region.id)}
                        >
                          {region.name}
                        </Button>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">Leave empty to apply to all regions</p>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label>Valid From</Label>
                      <Input
                        type="datetime-local"
                        value={formData.valid_from}
                        onChange={(e) => setFormData({ ...formData, valid_from: e.target.value })}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label>Valid Until</Label>
                      <Input
                        type="datetime-local"
                        value={formData.valid_until}
                        onChange={(e) => setFormData({ ...formData, valid_until: e.target.value })}
                      />
                      <p className="text-xs text-muted-foreground">Leave empty for no expiration</p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <Label>Active</Label>
                      <p className="text-xs text-muted-foreground">Rule will be applied to corporate bookings</p>
                    </div>
                    <Switch
                      checked={formData.is_active}
                      onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={resetForm}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                    {editingRule ? "Update Rule" : "Create Rule"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Total Rules</CardTitle>
              <Building2 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Active Rules</CardTitle>
              <CircleDollarSign className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">{stats.active}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Discount Rules</CardTitle>
              <Percent className="h-4 w-4 text-blue-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-500">{stats.discounts}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Expired</CardTitle>
              <Clock className="h-4 w-4 text-orange-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-orange-500">{stats.expired}</div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-center">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search rules..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-[180px]">
                  <Filter className="mr-2 h-4 w-4" />
                  <SelectValue placeholder="Rule Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  {RULE_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Rules Table */}
        <Card>
          <CardHeader>
            <CardTitle>Fare Rules</CardTitle>
            <CardDescription>
              {filteredRules.length} rule{filteredRules.length !== 1 ? 's' : ''} found
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
              </div>
            ) : filteredRules.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No corporate fare rules found. Create your first rule to get started.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Rule Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead>Vehicles</TableHead>
                    <TableHead>Validity</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRules.map((rule) => {
                    const ruleTypeInfo = getRuleTypeInfo(rule.rule_type);
                    const validity = isRuleValid(rule);
                    return (
                      <TableRow key={rule.id}>
                        <TableCell>
                          <div>
                            <div className="font-medium">{rule.name}</div>
                            {rule.description && (
                              <div className="text-xs text-muted-foreground line-clamp-1">
                                {rule.description}
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="gap-1">
                            <ruleTypeInfo.icon className="h-3 w-3" />
                            {ruleTypeInfo.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <span className="font-mono font-medium">{formatRuleValue(rule)}</span>
                        </TableCell>
                        <TableCell>
                          {rule.applies_to_vehicle_types?.length ? (
                            <span className="text-sm">{rule.applies_to_vehicle_types.length} selected</span>
                          ) : (
                            <span className="text-muted-foreground">All</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={validity === 'valid' ? 'default' : validity === 'upcoming' ? 'secondary' : 'destructive'}
                          >
                            {validity === 'valid' ? 'Active' : validity === 'upcoming' ? 'Upcoming' : 'Expired'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">{rule.priority}</Badge>
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={rule.is_active}
                            onCheckedChange={(checked) => 
                              toggleStatusMutation.mutate({ id: rule.id, is_active: checked })
                            }
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleEdit(rule)}
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-destructive hover:text-destructive"
                              onClick={() => {
                                if (confirm('Are you sure you want to delete this rule?')) {
                                  deleteMutation.mutate(rule.id);
                                }
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
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
