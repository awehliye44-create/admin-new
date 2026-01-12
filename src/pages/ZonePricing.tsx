import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AdminLayout } from "@/components/layout/AdminLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Plus, Edit, Trash2, Target, CircleDollarSign, Search, Filter, Percent, DollarSign, Clock } from "lucide-react";
import { format } from "date-fns";

interface ZonePricingRule {
  id: string;
  zone_id: string;
  vehicle_type_id: string | null;
  rule_type: string;
  value: number;
  min_fare: number | null;
  max_fare: number | null;
  applies_to: string;
  time_restrictions: any;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface CustomZone {
  id: string;
  name: string;
  zone_type: string;
  color: string | null;
}

interface VehicleType {
  id: string;
  name: string;
  slug: string;
}

const RULE_TYPES = [
  { value: 'multiplier', label: 'Fare Multiplier', icon: Percent, description: 'Multiply fare by a factor (e.g., 1.5x)' },
  { value: 'flat_rate', label: 'Flat Rate Addition', icon: DollarSign, description: 'Add a fixed amount to fare' },
  { value: 'fixed_fare', label: 'Fixed Fare', icon: CircleDollarSign, description: 'Override with a fixed fare' },
  { value: 'percentage_discount', label: 'Percentage Discount', icon: Percent, description: 'Apply a percentage discount' },
];

const APPLIES_TO_OPTIONS = [
  { value: 'both', label: 'Pickup & Dropoff' },
  { value: 'pickup', label: 'Pickup Only' },
  { value: 'dropoff', label: 'Dropoff Only' },
];

const DAYS_OF_WEEK = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

export default function ZonePricing() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<ZonePricingRule | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [zoneFilter, setZoneFilter] = useState<string>("all");
  const [enableTimeRestrictions, setEnableTimeRestrictions] = useState(false);

  const [formData, setFormData] = useState({
    zone_id: "",
    vehicle_type_id: "",
    rule_type: "multiplier",
    value: 1.0,
    min_fare: 0,
    max_fare: null as number | null,
    applies_to: "both",
    time_restrictions: {
      days: [0, 1, 2, 3, 4, 5, 6],
      start_time: "00:00",
      end_time: "23:59",
    },
    is_active: true,
  });

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ['zone-pricing-rules'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('zone_pricing_rules')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as ZonePricingRule[];
    },
  });

  const { data: zones = [] } = useQuery({
    queryKey: ['custom-zones'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('custom_zones')
        .select('id, name, zone_type, color')
        .eq('is_active', true)
        .order('name');
      if (error) throw error;
      return data as CustomZone[];
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

  const createMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      const { error } = await supabase.from('zone_pricing_rules').insert({
        zone_id: data.zone_id,
        vehicle_type_id: data.vehicle_type_id || null,
        rule_type: data.rule_type,
        value: data.value,
        min_fare: data.min_fare || null,
        max_fare: data.max_fare || null,
        applies_to: data.applies_to,
        time_restrictions: enableTimeRestrictions ? data.time_restrictions : null,
        is_active: data.is_active,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['zone-pricing-rules'] });
      toast({ title: "Pricing rule created successfully" });
      resetForm();
    },
    onError: (error: any) => {
      toast({ title: "Failed to create rule", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: typeof formData }) => {
      const { error } = await supabase.from('zone_pricing_rules').update({
        zone_id: data.zone_id,
        vehicle_type_id: data.vehicle_type_id || null,
        rule_type: data.rule_type,
        value: data.value,
        min_fare: data.min_fare || null,
        max_fare: data.max_fare || null,
        applies_to: data.applies_to,
        time_restrictions: enableTimeRestrictions ? data.time_restrictions : null,
        is_active: data.is_active,
      }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['zone-pricing-rules'] });
      toast({ title: "Pricing rule updated successfully" });
      resetForm();
    },
    onError: (error: any) => {
      toast({ title: "Failed to update rule", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('zone_pricing_rules').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['zone-pricing-rules'] });
      toast({ title: "Pricing rule deleted successfully" });
    },
    onError: (error: any) => {
      toast({ title: "Failed to delete rule", description: error.message, variant: "destructive" });
    },
  });

  const toggleStatusMutation = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase.from('zone_pricing_rules').update({ is_active }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['zone-pricing-rules'] });
      toast({ title: "Rule status updated" });
    },
  });

  const resetForm = () => {
    setFormData({
      zone_id: "",
      vehicle_type_id: "",
      rule_type: "multiplier",
      value: 1.0,
      min_fare: 0,
      max_fare: null,
      applies_to: "both",
      time_restrictions: {
        days: [0, 1, 2, 3, 4, 5, 6],
        start_time: "00:00",
        end_time: "23:59",
      },
      is_active: true,
    });
    setEnableTimeRestrictions(false);
    setEditingRule(null);
    setIsDialogOpen(false);
  };

  const handleEdit = (rule: ZonePricingRule) => {
    setEditingRule(rule);
    setEnableTimeRestrictions(!!rule.time_restrictions);
    setFormData({
      zone_id: rule.zone_id,
      vehicle_type_id: rule.vehicle_type_id || "",
      rule_type: rule.rule_type,
      value: rule.value,
      min_fare: rule.min_fare || 0,
      max_fare: rule.max_fare,
      applies_to: rule.applies_to,
      time_restrictions: rule.time_restrictions || {
        days: [0, 1, 2, 3, 4, 5, 6],
        start_time: "00:00",
        end_time: "23:59",
      },
      is_active: rule.is_active,
    });
    setIsDialogOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.zone_id) {
      toast({ title: "Please select a zone", variant: "destructive" });
      return;
    }
    if (editingRule) {
      updateMutation.mutate({ id: editingRule.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const getZoneName = (zoneId: string) => {
    const zone = zones.find(z => z.id === zoneId);
    return zone?.name || "Unknown Zone";
  };

  const getZone = (zoneId: string) => {
    return zones.find(z => z.id === zoneId);
  };

  const getVehicleTypeName = (vehicleTypeId: string | null) => {
    if (!vehicleTypeId) return "All Vehicles";
    const vehicleType = vehicleTypes.find(v => v.id === vehicleTypeId);
    return vehicleType?.name || "Unknown";
  };

  const getRuleTypeInfo = (type: string) => {
    return RULE_TYPES.find(t => t.value === type) || RULE_TYPES[0];
  };

  const formatRuleValue = (rule: ZonePricingRule) => {
    switch (rule.rule_type) {
      case 'multiplier':
        return `${rule.value}x`;
      case 'flat_rate':
        return `+£${rule.value.toFixed(2)}`;
      case 'fixed_fare':
        return `£${rule.value.toFixed(2)}`;
      case 'percentage_discount':
        return `-${rule.value}%`;
      default:
        return rule.value.toString();
    }
  };

  const filteredRules = rules.filter(rule => {
    const zone = getZone(rule.zone_id);
    const matchesSearch = zone?.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesZone = zoneFilter === "all" || rule.zone_id === zoneFilter;
    return matchesSearch && matchesZone;
  });

  const stats = {
    total: rules.length,
    active: rules.filter(r => r.is_active).length,
    multipliers: rules.filter(r => r.rule_type === 'multiplier').length,
    discounts: rules.filter(r => r.rule_type === 'percentage_discount').length,
  };

  const toggleDay = (day: number) => {
    const currentDays = formData.time_restrictions.days;
    const newDays = currentDays.includes(day)
      ? currentDays.filter((d: number) => d !== day)
      : [...currentDays, day];
    setFormData({
      ...formData,
      time_restrictions: { ...formData.time_restrictions, days: newDays },
    });
  };

  return (
    <AdminLayout title="Geofence & Zone Pricing">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Geofence & Zone Pricing</h1>
            <p className="text-muted-foreground">Configure pricing rules for custom zones</p>
          </div>
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button onClick={() => resetForm()}>
                <Plus className="mr-2 h-4 w-4" />
                Add Pricing Rule
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <form onSubmit={handleSubmit}>
                <DialogHeader>
                  <DialogTitle>{editingRule ? "Edit Pricing Rule" : "Create Pricing Rule"}</DialogTitle>
                  <DialogDescription>
                    Define how fares are calculated for this zone
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4 max-h-[60vh] overflow-y-auto">
                  <div className="grid gap-2">
                    <Label>Zone *</Label>
                    <Select
                      value={formData.zone_id}
                      onValueChange={(value) => setFormData({ ...formData, zone_id: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select a zone" />
                      </SelectTrigger>
                      <SelectContent>
                        {zones.map((zone) => (
                          <SelectItem key={zone.id} value={zone.id}>
                            <div className="flex items-center gap-2">
                              <div
                                className="h-3 w-3 rounded-full"
                                style={{ backgroundColor: zone.color || '#3B82F6' }}
                              />
                              {zone.name}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid gap-2">
                    <Label>Vehicle Type</Label>
                    <Select
                      value={formData.vehicle_type_id || "all"}
                      onValueChange={(value) => setFormData({ ...formData, vehicle_type_id: value === "all" ? "" : value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="All Vehicle Types" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Vehicle Types</SelectItem>
                        {vehicleTypes.map((type) => (
                          <SelectItem key={type.id} value={type.id}>{type.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label>Rule Type *</Label>
                      <Select
                        value={formData.rule_type}
                        onValueChange={(value) => setFormData({ ...formData, rule_type: value })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {RULE_TYPES.map((type) => (
                            <SelectItem key={type.value} value={type.value}>
                              {type.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="grid gap-2">
                      <Label>Value *</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={formData.value}
                        onChange={(e) => setFormData({ ...formData, value: parseFloat(e.target.value) || 0 })}
                        placeholder={formData.rule_type === 'multiplier' ? "1.5" : "5.00"}
                      />
                    </div>
                  </div>

                  <div className="grid gap-2">
                    <Label>Applies To</Label>
                    <Select
                      value={formData.applies_to}
                      onValueChange={(value) => setFormData({ ...formData, applies_to: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {APPLIES_TO_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label>Min Fare (£)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={formData.min_fare || ""}
                        onChange={(e) => setFormData({ ...formData, min_fare: parseFloat(e.target.value) || 0 })}
                        placeholder="0.00"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label>Max Fare (£)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={formData.max_fare || ""}
                        onChange={(e) => setFormData({ ...formData, max_fare: e.target.value ? parseFloat(e.target.value) : null })}
                        placeholder="No limit"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <Label>Time Restrictions</Label>
                        <p className="text-xs text-muted-foreground">Limit when this rule applies</p>
                      </div>
                    </div>
                    <Switch
                      checked={enableTimeRestrictions}
                      onCheckedChange={setEnableTimeRestrictions}
                    />
                  </div>

                  {enableTimeRestrictions && (
                    <div className="space-y-4 rounded-lg border p-4">
                      <div className="grid gap-2">
                        <Label>Days of Week</Label>
                        <div className="flex flex-wrap gap-2">
                          {DAYS_OF_WEEK.map((day) => (
                            <Button
                              key={day.value}
                              type="button"
                              variant={formData.time_restrictions.days.includes(day.value) ? "default" : "outline"}
                              size="sm"
                              onClick={() => toggleDay(day.value)}
                            >
                              {day.label}
                            </Button>
                          ))}
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="grid gap-2">
                          <Label>Start Time</Label>
                          <Input
                            type="time"
                            value={formData.time_restrictions.start_time}
                            onChange={(e) => setFormData({
                              ...formData,
                              time_restrictions: { ...formData.time_restrictions, start_time: e.target.value }
                            })}
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label>End Time</Label>
                          <Input
                            type="time"
                            value={formData.time_restrictions.end_time}
                            onChange={(e) => setFormData({
                              ...formData,
                              time_restrictions: { ...formData.time_restrictions, end_time: e.target.value }
                            })}
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <Label>Active</Label>
                      <p className="text-xs text-muted-foreground">Rule will be applied to fare calculations</p>
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
              <Target className="h-4 w-4 text-muted-foreground" />
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
              <CardTitle className="text-sm font-medium">Multipliers</CardTitle>
              <Percent className="h-4 w-4 text-blue-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-500">{stats.multipliers}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Discounts</CardTitle>
              <DollarSign className="h-4 w-4 text-purple-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-purple-500">{stats.discounts}</div>
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
                  placeholder="Search by zone name..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <Select value={zoneFilter} onValueChange={setZoneFilter}>
                <SelectTrigger className="w-[200px]">
                  <Filter className="mr-2 h-4 w-4" />
                  <SelectValue placeholder="Filter by Zone" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Zones</SelectItem>
                  {zones.map((zone) => (
                    <SelectItem key={zone.id} value={zone.id}>{zone.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Rules Table */}
        <Card>
          <CardHeader>
            <CardTitle>Pricing Rules</CardTitle>
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
                No pricing rules found. Create zones first, then add pricing rules.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Zone</TableHead>
                    <TableHead>Vehicle Type</TableHead>
                    <TableHead>Rule Type</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead>Applies To</TableHead>
                    <TableHead>Restrictions</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRules.map((rule) => {
                    const zone = getZone(rule.zone_id);
                    const ruleTypeInfo = getRuleTypeInfo(rule.rule_type);
                    return (
                      <TableRow key={rule.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div
                              className="h-3 w-3 rounded-full"
                              style={{ backgroundColor: zone?.color || '#3B82F6' }}
                            />
                            <span className="font-medium">{getZoneName(rule.zone_id)}</span>
                          </div>
                        </TableCell>
                        <TableCell>{getVehicleTypeName(rule.vehicle_type_id)}</TableCell>
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
                          <Badge variant="secondary">
                            {APPLIES_TO_OPTIONS.find(o => o.value === rule.applies_to)?.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {rule.time_restrictions ? (
                            <Badge variant="outline" className="gap-1">
                              <Clock className="h-3 w-3" />
                              Time-limited
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">Always</span>
                          )}
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
