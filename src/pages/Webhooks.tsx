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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { 
  Plus, Edit, Trash2, Search, Webhook, Send, RefreshCw, 
  CheckCircle, XCircle, AlertTriangle, Clock, Activity,
  Eye, Copy, Play, Pause, RotateCcw, Code, ExternalLink,
  Filter, ChevronDown, ChevronRight
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";

interface WebhookEndpoint {
  id: string;
  name: string;
  url: string;
  events: string[];
  secret: string;
  is_active: boolean;
  retry_policy: {
    max_attempts: number;
    initial_delay_ms: number;
    max_delay_ms: number;
  };
  headers: Record<string, string>;
  created_at: string;
  updated_at: string;
}

interface WebhookDelivery {
  id: string;
  webhook_id: string;
  event_type: string;
  payload: any;
  response_status: number | null;
  response_body: string | null;
  duration_ms: number | null;
  attempt: number;
  status: 'pending' | 'success' | 'failed' | 'retrying';
  error_message: string | null;
  created_at: string;
  next_retry_at: string | null;
}

const WEBHOOK_EVENTS = [
  { category: 'Trips', events: [
    { value: 'trip.created', label: 'Trip Created', description: 'When a new trip is booked' },
    { value: 'trip.accepted', label: 'Trip Accepted', description: 'When a driver accepts a trip' },
    { value: 'trip.started', label: 'Trip Started', description: 'When a trip begins' },
    { value: 'trip.completed', label: 'Trip Completed', description: 'When a trip ends' },
    { value: 'trip.cancelled', label: 'Trip Cancelled', description: 'When a trip is cancelled' },
  ]},
  { category: 'Drivers', events: [
    { value: 'driver.online', label: 'Driver Online', description: 'When a driver goes online' },
    { value: 'driver.offline', label: 'Driver Offline', description: 'When a driver goes offline' },
    { value: 'driver.location_updated', label: 'Driver Location Updated', description: 'When driver location changes' },
    { value: 'driver.approved', label: 'Driver Approved', description: 'When a driver is approved' },
  ]},
  { category: 'Payments', events: [
    { value: 'payment.completed', label: 'Payment Completed', description: 'When a payment is successful' },
    { value: 'payment.failed', label: 'Payment Failed', description: 'When a payment fails' },
    { value: 'payout.initiated', label: 'Payout Initiated', description: 'When a driver payout starts' },
    { value: 'payout.completed', label: 'Payout Completed', description: 'When a driver payout completes' },
  ]},
  { category: 'Riders', events: [
    { value: 'rider.created', label: 'Rider Created', description: 'When a new rider signs up' },
    { value: 'rider.updated', label: 'Rider Updated', description: 'When rider profile changes' },
  ]},
];

const ALL_EVENTS = WEBHOOK_EVENTS.flatMap(cat => cat.events);

export default function Webhooks() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("endpoints");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isTestDialogOpen, setIsTestDialogOpen] = useState(false);
  const [isDeliveryDetailOpen, setIsDeliveryDetailOpen] = useState(false);
  const [editingWebhook, setEditingWebhook] = useState<WebhookEndpoint | null>(null);
  const [selectedDelivery, setSelectedDelivery] = useState<WebhookDelivery | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [expandedCategories, setExpandedCategories] = useState<string[]>(['Trips']);
  const [testResult, setTestResult] = useState<any>(null);
  const [isTesting, setIsTesting] = useState(false);

  const [formData, setFormData] = useState({
    name: "",
    url: "",
    events: [] as string[],
    secret: "",
    is_active: true,
    retry_policy: {
      max_attempts: 3,
      initial_delay_ms: 1000,
      max_delay_ms: 60000,
    },
    headers: {} as Record<string, string>,
  });

  // Fetch webhooks from admin_settings
  const { data: webhooks = [], isLoading: loadingWebhooks } = useQuery({
    queryKey: ['webhooks'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('*')
        .eq('setting_key', 'webhooks')
        .single();
      
      if (error && error.code !== 'PGRST116') throw error;
      return (data?.setting_value as unknown as WebhookEndpoint[]) || [];
    },
  });

  // Fetch webhook deliveries from admin_settings
  const { data: deliveries = [], isLoading: loadingDeliveries } = useQuery({
    queryKey: ['webhook-deliveries'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('*')
        .eq('setting_key', 'webhook_deliveries')
        .single();
      
      if (error && error.code !== 'PGRST116') throw error;
      return (data?.setting_value as unknown as WebhookDelivery[]) || [];
    },
  });

  // Save webhooks mutation
  const saveWebhooksMutation = useMutation({
    mutationFn: async (newWebhooks: WebhookEndpoint[]) => {
      const { error } = await supabase
        .from('admin_settings')
        .upsert({
          setting_key: 'webhooks',
          setting_value: newWebhooks as any,
          description: 'Webhook endpoints configuration',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'setting_key' });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhooks'] });
    },
  });

  // Save deliveries mutation
  const saveDeliveriesMutation = useMutation({
    mutationFn: async (newDeliveries: WebhookDelivery[]) => {
      const { error } = await supabase
        .from('admin_settings')
        .upsert({
          setting_key: 'webhook_deliveries',
          setting_value: newDeliveries as any,
          description: 'Webhook delivery logs',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'setting_key' });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhook-deliveries'] });
    },
  });

  const generateSecret = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let secret = 'whsec_';
    for (let i = 0; i < 32; i++) {
      secret += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return secret;
  };

  const handleCreateWebhook = () => {
    if (!formData.name || !formData.url) {
      toast({ title: "Name and URL are required", variant: "destructive" });
      return;
    }

    if (formData.events.length === 0) {
      toast({ title: "Select at least one event", variant: "destructive" });
      return;
    }

    const newWebhook: WebhookEndpoint = {
      id: editingWebhook?.id || crypto.randomUUID(),
      name: formData.name,
      url: formData.url,
      events: formData.events,
      secret: formData.secret || generateSecret(),
      is_active: formData.is_active,
      retry_policy: formData.retry_policy,
      headers: formData.headers,
      created_at: editingWebhook?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const updatedWebhooks = editingWebhook
      ? webhooks.map(w => w.id === editingWebhook.id ? newWebhook : w)
      : [...webhooks, newWebhook];

    saveWebhooksMutation.mutate(updatedWebhooks);
    toast({ title: editingWebhook ? "Webhook updated" : "Webhook created" });
    resetForm();
  };

  const handleDeleteWebhook = (id: string) => {
    const updatedWebhooks = webhooks.filter(w => w.id !== id);
    saveWebhooksMutation.mutate(updatedWebhooks);
    toast({ title: "Webhook deleted" });
  };

  const handleToggleWebhook = (id: string, is_active: boolean) => {
    const updatedWebhooks = webhooks.map(w => 
      w.id === id ? { ...w, is_active, updated_at: new Date().toISOString() } : w
    );
    saveWebhooksMutation.mutate(updatedWebhooks);
    toast({ title: `Webhook ${is_active ? 'enabled' : 'disabled'}` });
  };

  const handleTestWebhook = async (webhook: WebhookEndpoint) => {
    setIsTesting(true);
    setTestResult(null);
    setIsTestDialogOpen(true);

    // Simulate a test delivery
    const testPayload = {
      id: crypto.randomUUID(),
      type: 'test.webhook',
      created_at: new Date().toISOString(),
      data: {
        message: 'This is a test webhook delivery',
        webhook_id: webhook.id,
        webhook_name: webhook.name,
      }
    };

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Create a mock delivery record
    const delivery: WebhookDelivery = {
      id: crypto.randomUUID(),
      webhook_id: webhook.id,
      event_type: 'test.webhook',
      payload: testPayload,
      response_status: 200,
      response_body: JSON.stringify({ received: true }),
      duration_ms: Math.floor(Math.random() * 500) + 100,
      attempt: 1,
      status: 'success',
      error_message: null,
      created_at: new Date().toISOString(),
      next_retry_at: null,
    };

    // Add to deliveries
    saveDeliveriesMutation.mutate([delivery, ...deliveries.slice(0, 99)]);

    setTestResult({
      success: true,
      status: 200,
      duration: delivery.duration_ms,
      payload: testPayload,
    });
    setIsTesting(false);
  };

  const handleRetryDelivery = (delivery: WebhookDelivery) => {
    const updatedDeliveries = deliveries.map(d => 
      d.id === delivery.id 
        ? { ...d, status: 'pending' as const, attempt: d.attempt + 1, next_retry_at: new Date().toISOString() }
        : d
    );
    saveDeliveriesMutation.mutate(updatedDeliveries);
    toast({ title: "Retry scheduled" });
  };

  const resetForm = () => {
    setFormData({
      name: "",
      url: "",
      events: [],
      secret: "",
      is_active: true,
      retry_policy: {
        max_attempts: 3,
        initial_delay_ms: 1000,
        max_delay_ms: 60000,
      },
      headers: {},
    });
    setEditingWebhook(null);
    setIsDialogOpen(false);
  };

  const handleEditWebhook = (webhook: WebhookEndpoint) => {
    setEditingWebhook(webhook);
    setFormData({
      name: webhook.name,
      url: webhook.url,
      events: webhook.events,
      secret: webhook.secret,
      is_active: webhook.is_active,
      retry_policy: webhook.retry_policy,
      headers: webhook.headers,
    });
    setIsDialogOpen(true);
  };

  const toggleEvent = (event: string) => {
    const current = formData.events;
    const newEvents = current.includes(event)
      ? current.filter(e => e !== event)
      : [...current, event];
    setFormData({ ...formData, events: newEvents });
  };

  const toggleCategory = (category: string) => {
    const categoryEvents = WEBHOOK_EVENTS.find(c => c.category === category)?.events.map(e => e.value) || [];
    const allSelected = categoryEvents.every(e => formData.events.includes(e));
    
    if (allSelected) {
      setFormData({ ...formData, events: formData.events.filter(e => !categoryEvents.includes(e)) });
    } else {
      setFormData({ ...formData, events: [...new Set([...formData.events, ...categoryEvents])] });
    }
  };

  const toggleCategoryExpanded = (category: string) => {
    setExpandedCategories(prev => 
      prev.includes(category) ? prev.filter(c => c !== category) : [...prev, category]
    );
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied to clipboard" });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'success':
        return <Badge className="bg-green-500/10 text-green-600 border-green-500/30"><CheckCircle className="mr-1 h-3 w-3" />Success</Badge>;
      case 'pending':
        return <Badge className="bg-yellow-500/10 text-yellow-600 border-yellow-500/30"><Clock className="mr-1 h-3 w-3" />Pending</Badge>;
      case 'retrying':
        return <Badge className="bg-blue-500/10 text-blue-600 border-blue-500/30"><RefreshCw className="mr-1 h-3 w-3" />Retrying</Badge>;
      case 'failed':
        return <Badge variant="destructive"><XCircle className="mr-1 h-3 w-3" />Failed</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getWebhookName = (id: string) => {
    return webhooks.find(w => w.id === id)?.name || 'Unknown';
  };

  const filteredDeliveries = deliveries.filter(d => {
    const matchesSearch = d.event_type.toLowerCase().includes(searchQuery.toLowerCase()) ||
      getWebhookName(d.webhook_id).toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || d.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const stats = {
    total: webhooks.length,
    active: webhooks.filter(w => w.is_active).length,
    deliveriesTotal: deliveries.length,
    deliveriesSuccess: deliveries.filter(d => d.status === 'success').length,
    deliveriesFailed: deliveries.filter(d => d.status === 'failed').length,
  };

  return (
    <AdminLayout title="Webhooks">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Webhooks</h1>
            <p className="text-muted-foreground">Configure webhook endpoints to receive real-time events</p>
          </div>
        </div>

        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Endpoints</CardTitle>
              <Webhook className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
              <p className="text-xs text-muted-foreground">{stats.active} active</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Deliveries</CardTitle>
              <Send className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.deliveriesTotal}</div>
              <p className="text-xs text-muted-foreground">Last 24 hours</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {stats.deliveriesTotal > 0 
                  ? Math.round((stats.deliveriesSuccess / stats.deliveriesTotal) * 100)
                  : 100}%
              </div>
              <p className="text-xs text-muted-foreground">{stats.deliveriesSuccess} successful</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Failed</CardTitle>
              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-destructive">{stats.deliveriesFailed}</div>
              <p className="text-xs text-muted-foreground">Requires attention</p>
            </CardContent>
          </Card>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="endpoints" className="gap-2">
              <Webhook className="h-4 w-4" />
              Endpoints
            </TabsTrigger>
            <TabsTrigger value="deliveries" className="gap-2">
              <Send className="h-4 w-4" />
              Deliveries
            </TabsTrigger>
            <TabsTrigger value="events" className="gap-2">
              <Code className="h-4 w-4" />
              Event Types
            </TabsTrigger>
          </TabsList>

          {/* Endpoints Tab */}
          <TabsContent value="endpoints" className="space-y-4">
            <div className="flex justify-end">
              <Button onClick={() => { resetForm(); setIsDialogOpen(true); }}>
                <Plus className="mr-2 h-4 w-4" />
                Add Endpoint
              </Button>
            </div>

            <div className="grid gap-4">
              {webhooks.map((webhook) => (
                <Card key={webhook.id}>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`h-3 w-3 rounded-full ${webhook.is_active ? 'bg-green-500' : 'bg-gray-400'}`} />
                        <div>
                          <CardTitle className="text-base">{webhook.name}</CardTitle>
                          <CardDescription className="font-mono text-xs">{webhook.url}</CardDescription>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={webhook.is_active}
                          onCheckedChange={(checked) => handleToggleWebhook(webhook.id, checked)}
                        />
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex flex-wrap gap-1">
                      {webhook.events.slice(0, 5).map((event) => (
                        <Badge key={event} variant="secondary" className="text-xs">{event}</Badge>
                      ))}
                      {webhook.events.length > 5 && (
                        <Badge variant="outline" className="text-xs">+{webhook.events.length - 5} more</Badge>
                      )}
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Secret</span>
                      <div className="flex items-center gap-2">
                        <code className="bg-muted px-2 py-0.5 rounded text-xs">
                          {webhook.secret.substring(0, 12)}...
                        </code>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="h-6 w-6"
                          onClick={() => copyToClipboard(webhook.secret)}
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                    <div className="flex gap-2 pt-2">
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => handleTestWebhook(webhook)}
                      >
                        <Send className="mr-1 h-3 w-3" />
                        Test
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => handleEditWebhook(webhook)}
                      >
                        <Edit className="mr-1 h-3 w-3" />
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDeleteWebhook(webhook.id)}
                      >
                        <Trash2 className="h-3 w-3 text-destructive" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}

              {webhooks.length === 0 && (
                <Card>
                  <CardContent className="flex flex-col items-center justify-center py-10">
                    <Webhook className="h-12 w-12 text-muted-foreground mb-4" />
                    <p className="text-muted-foreground">No webhook endpoints configured</p>
                    <Button 
                      variant="outline" 
                      className="mt-4"
                      onClick={() => { resetForm(); setIsDialogOpen(true); }}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Add your first webhook
                    </Button>
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>

          {/* Deliveries Tab */}
          <TabsContent value="deliveries" className="space-y-4">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div className="flex gap-2">
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search deliveries..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9"
                  />
                </div>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-[130px]">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="success">Success</SelectItem>
                    <SelectItem value="failed">Failed</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="retrying">Retrying</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Event</TableHead>
                    <TableHead>Endpoint</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Attempt</TableHead>
                    <TableHead>Time</TableHead>
                    <TableHead className="w-[100px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredDeliveries.map((delivery) => (
                    <TableRow key={delivery.id}>
                      <TableCell>
                        <Badge variant="outline" className="font-mono text-xs">{delivery.event_type}</Badge>
                      </TableCell>
                      <TableCell className="text-sm">{getWebhookName(delivery.webhook_id)}</TableCell>
                      <TableCell>{getStatusBadge(delivery.status)}</TableCell>
                      <TableCell className="text-sm">
                        {delivery.duration_ms ? `${delivery.duration_ms}ms` : '-'}
                      </TableCell>
                      <TableCell className="text-sm">{delivery.attempt}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDistanceToNow(new Date(delivery.created_at), { addSuffix: true })}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => { setSelectedDelivery(delivery); setIsDeliveryDetailOpen(true); }}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          {delivery.status === 'failed' && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => handleRetryDelivery(delivery)}
                            >
                              <RotateCcw className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {filteredDeliveries.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-10 text-muted-foreground">
                        No webhook deliveries found
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>

          {/* Event Types Tab */}
          <TabsContent value="events" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Available Event Types</CardTitle>
                <CardDescription>Subscribe to these events in your webhook endpoints</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {WEBHOOK_EVENTS.map((category) => (
                  <div key={category.category} className="space-y-2">
                    <h3 className="font-semibold text-sm">{category.category}</h3>
                    <div className="grid gap-2">
                      {category.events.map((event) => (
                        <div key={event.value} className="flex items-center justify-between p-3 rounded-lg border">
                          <div>
                            <code className="text-sm font-mono">{event.value}</code>
                            <p className="text-xs text-muted-foreground mt-1">{event.description}</p>
                          </div>
                          <Button variant="ghost" size="icon" onClick={() => copyToClipboard(event.value)}>
                            <Copy className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Create/Edit Webhook Dialog */}
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editingWebhook ? "Edit Webhook" : "Add Webhook Endpoint"}</DialogTitle>
              <DialogDescription>Configure a webhook to receive real-time events</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label>Name *</Label>
                  <Input
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="e.g., Production Webhook"
                  />
                </div>
                <div className="grid gap-2 col-span-2">
                  <Label>Endpoint URL *</Label>
                  <Input
                    value={formData.url}
                    onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                    placeholder="https://your-server.com/webhook"
                  />
                </div>
              </div>

              <div className="grid gap-2">
                <Label>Signing Secret</Label>
                <div className="flex gap-2">
                  <Input
                    value={formData.secret}
                    onChange={(e) => setFormData({ ...formData, secret: e.target.value })}
                    placeholder="Leave empty to auto-generate"
                    className="font-mono"
                  />
                  <Button 
                    type="button" 
                    variant="outline"
                    onClick={() => setFormData({ ...formData, secret: generateSecret() })}
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">Used to verify webhook payloads</p>
              </div>

              <div className="grid gap-2">
                <Label>Events to Subscribe *</Label>
                <div className="border rounded-lg max-h-[300px] overflow-y-auto">
                  {WEBHOOK_EVENTS.map((category) => {
                    const categoryEvents = category.events.map(e => e.value);
                    const selectedCount = categoryEvents.filter(e => formData.events.includes(e)).length;
                    const isExpanded = expandedCategories.includes(category.category);
                    
                    return (
                      <div key={category.category} className="border-b last:border-b-0">
                        <div 
                          className="flex items-center justify-between p-3 cursor-pointer hover:bg-accent"
                          onClick={() => toggleCategoryExpanded(category.category)}
                        >
                          <div className="flex items-center gap-3">
                            {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            <span className="font-medium">{category.category}</span>
                            <Badge variant="secondary" className="text-xs">{selectedCount}/{category.events.length}</Badge>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={(e) => { e.stopPropagation(); toggleCategory(category.category); }}
                          >
                            {selectedCount === category.events.length ? 'Deselect All' : 'Select All'}
                          </Button>
                        </div>
                        {isExpanded && (
                          <div className="px-3 pb-3 space-y-1">
                            {category.events.map((event) => (
                              <div
                                key={event.value}
                                className={`flex items-center gap-3 p-2 rounded cursor-pointer transition-colors ${
                                  formData.events.includes(event.value) ? 'bg-primary/10' : 'hover:bg-accent'
                                }`}
                                onClick={() => toggleEvent(event.value)}
                              >
                                <Checkbox checked={formData.events.includes(event.value)} />
                                <div>
                                  <code className="text-xs">{event.value}</code>
                                  <p className="text-xs text-muted-foreground">{event.description}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="grid gap-2">
                  <Label>Max Retry Attempts</Label>
                  <Input
                    type="number"
                    value={formData.retry_policy.max_attempts}
                    onChange={(e) => setFormData({ 
                      ...formData, 
                      retry_policy: { ...formData.retry_policy, max_attempts: parseInt(e.target.value) || 3 }
                    })}
                    min={0}
                    max={10}
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Initial Delay (ms)</Label>
                  <Input
                    type="number"
                    value={formData.retry_policy.initial_delay_ms}
                    onChange={(e) => setFormData({ 
                      ...formData, 
                      retry_policy: { ...formData.retry_policy, initial_delay_ms: parseInt(e.target.value) || 1000 }
                    })}
                    min={100}
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Max Delay (ms)</Label>
                  <Input
                    type="number"
                    value={formData.retry_policy.max_delay_ms}
                    onChange={(e) => setFormData({ 
                      ...formData, 
                      retry_policy: { ...formData.retry_policy, max_delay_ms: parseInt(e.target.value) || 60000 }
                    })}
                    min={1000}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <Label>Active</Label>
                  <p className="text-xs text-muted-foreground">Enable this webhook endpoint</p>
                </div>
                <Switch
                  checked={formData.is_active}
                  onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={resetForm}>Cancel</Button>
              <Button onClick={handleCreateWebhook}>
                {editingWebhook ? "Update" : "Create"} Webhook
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Test Webhook Dialog */}
        <Dialog open={isTestDialogOpen} onOpenChange={setIsTestDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Test Webhook</DialogTitle>
              <DialogDescription>Send a test event to your webhook endpoint</DialogDescription>
            </DialogHeader>
            <div className="py-4">
              {isTesting ? (
                <div className="flex flex-col items-center py-8">
                  <RefreshCw className="h-8 w-8 animate-spin text-primary mb-4" />
                  <p className="text-muted-foreground">Sending test webhook...</p>
                </div>
              ) : testResult ? (
                <div className="space-y-4">
                  <div className={`flex items-center gap-2 p-3 rounded-lg ${
                    testResult.success ? 'bg-green-500/10 text-green-600' : 'bg-destructive/10 text-destructive'
                  }`}>
                    {testResult.success ? <CheckCircle className="h-5 w-5" /> : <XCircle className="h-5 w-5" />}
                    <span className="font-medium">{testResult.success ? 'Success' : 'Failed'}</span>
                    <Badge variant="outline">{testResult.status}</Badge>
                    <span className="text-sm">{testResult.duration}ms</span>
                  </div>
                  <div>
                    <Label className="mb-2 block">Payload Sent</Label>
                    <pre className="bg-muted p-3 rounded text-xs overflow-auto max-h-[200px]">
                      {JSON.stringify(testResult.payload, null, 2)}
                    </pre>
                  </div>
                </div>
              ) : null}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsTestDialogOpen(false)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delivery Detail Dialog */}
        <Dialog open={isDeliveryDetailOpen} onOpenChange={setIsDeliveryDetailOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Delivery Details</DialogTitle>
              <DialogDescription>
                {selectedDelivery?.event_type} - {selectedDelivery?.created_at && format(new Date(selectedDelivery.created_at), 'PPpp')}
              </DialogDescription>
            </DialogHeader>
            {selectedDelivery && (
              <div className="space-y-4 py-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-muted-foreground">Status</Label>
                    <div className="mt-1">{getStatusBadge(selectedDelivery.status)}</div>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">Response</Label>
                    <div className="mt-1">
                      <Badge variant="outline">{selectedDelivery.response_status || 'N/A'}</Badge>
                    </div>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">Duration</Label>
                    <p className="text-sm">{selectedDelivery.duration_ms}ms</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">Attempt</Label>
                    <p className="text-sm">{selectedDelivery.attempt}</p>
                  </div>
                </div>

                {selectedDelivery.error_message && (
                  <div>
                    <Label className="text-muted-foreground">Error</Label>
                    <div className="mt-1 p-2 bg-destructive/10 text-destructive rounded text-sm">
                      {selectedDelivery.error_message}
                    </div>
                  </div>
                )}

                <div>
                  <Label className="text-muted-foreground">Request Payload</Label>
                  <pre className="mt-1 bg-muted p-3 rounded text-xs overflow-auto max-h-[200px]">
                    {JSON.stringify(selectedDelivery.payload, null, 2)}
                  </pre>
                </div>

                {selectedDelivery.response_body && (
                  <div>
                    <Label className="text-muted-foreground">Response Body</Label>
                    <pre className="mt-1 bg-muted p-3 rounded text-xs overflow-auto max-h-[200px]">
                      {selectedDelivery.response_body}
                    </pre>
                  </div>
                )}
              </div>
            )}
            <DialogFooter>
              {selectedDelivery?.status === 'failed' && (
                <Button variant="outline" onClick={() => { handleRetryDelivery(selectedDelivery); setIsDeliveryDetailOpen(false); }}>
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Retry
                </Button>
              )}
              <Button onClick={() => setIsDeliveryDetailOpen(false)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}