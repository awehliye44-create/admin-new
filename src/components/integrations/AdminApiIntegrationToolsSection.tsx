import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { 
  Plus, Trash2, Search, Key, Zap, Copy, Eye, EyeOff, 
  CheckCircle, XCircle, AlertTriangle, ExternalLink, 
  Code, Settings2, Link2, Unlink
} from "lucide-react";
import { format } from "date-fns";

interface Integration {
  id: string;
  name: string;
  provider: string;
  type: string;
  status: 'active' | 'inactive' | 'error';
  api_key: string | null;
  api_secret: string | null;
  webhook_url: string | null;
  config: Record<string, any>;
  last_sync: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface ApiKey {
  id: string;
  name: string;
  key: string;
  prefix: string;
  permissions: string[];
  rate_limit: number;
  is_active: boolean;
  last_used: string | null;
  expires_at: string | null;
  created_at: string;
}

const INTEGRATION_PROVIDERS = [
  { value: 'twilio', label: 'Twilio', icon: '📱', description: 'SMS & Voice' },
  { value: 'sendgrid', label: 'SendGrid', icon: '📧', description: 'Email delivery' },
  { value: 'mapbox', label: 'Mapbox', icon: '🗺️', description: 'Maps & Geocoding' },
  { value: 'firebase', label: 'Firebase', icon: '🔥', description: 'Push notifications' },
  { value: 'segment', label: 'Segment', icon: '📊', description: 'Analytics' },
  { value: 'intercom', label: 'Intercom', icon: '💬', description: 'Customer support' },
  { value: 'slack', label: 'Slack', icon: '💼', description: 'Team notifications' },
  { value: 'custom', label: 'Custom API', icon: '🔧', description: 'Custom integration' },
];

const PERMISSION_OPTIONS = [
  { value: 'read:trips', label: 'Read Trips' },
  { value: 'write:trips', label: 'Write Trips' },
  { value: 'read:drivers', label: 'Read Drivers' },
  { value: 'write:drivers', label: 'Write Drivers' },
  { value: 'read:riders', label: 'Read Riders' },
  { value: 'write:riders', label: 'Write Riders' },
  { value: 'read:pricing', label: 'Read Pricing' },
  { value: 'write:pricing', label: 'Write Pricing' },
  { value: 'webhooks', label: 'Manage Webhooks' },
];

export function AdminApiIntegrationToolsSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isIntegrationDialogOpen, setIsIntegrationDialogOpen] = useState(false);
  const [isApiKeyDialogOpen, setIsApiKeyDialogOpen] = useState(false);
  const [editingIntegration, setEditingIntegration] = useState<Integration | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [newApiKey, setNewApiKey] = useState<string | null>(null);

  const [integrationForm, setIntegrationForm] = useState({
    name: "",
    provider: "",
    type: "api",
    api_key: "",
    api_secret: "",
    webhook_url: "",
    config: {} as Record<string, any>,
    status: "active" as 'active' | 'inactive',
  });

  const [apiKeyForm, setApiKeyForm] = useState({
    name: "",
    permissions: [] as string[],
    rate_limit: 1000,
    expires_at: "",
  });

  // Fetch integrations from admin_settings
  const { data: integrations = [], isLoading: loadingIntegrations } = useQuery({
    queryKey: ['integrations'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('*')
        .eq('setting_key', 'integrations')
        .single();
      
      if (error && error.code !== 'PGRST116') throw error;
      return (data?.setting_value as unknown as Integration[]) || [];
    },
  });

  // Fetch API keys from admin_settings
  const { data: apiKeys = [], isLoading: loadingApiKeys } = useQuery({
    queryKey: ['api-keys'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('*')
        .eq('setting_key', 'api_keys')
        .single();
      
      if (error && error.code !== 'PGRST116') throw error;
      return (data?.setting_value as unknown as ApiKey[]) || [];
    },
  });

  // Save integrations mutation
  const saveIntegrationsMutation = useMutation({
    mutationFn: async (newIntegrations: Integration[]) => {
      const { error } = await supabase
        .from('admin_settings')
        .upsert({
          setting_key: 'integrations',
          setting_value: newIntegrations as any,
          description: 'Third-party integrations configuration',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'setting_key' });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['integrations'] });
    },
  });

  // Save API keys mutation
  const saveApiKeysMutation = useMutation({
    mutationFn: async (newApiKeys: ApiKey[]) => {
      const { error } = await supabase
        .from('admin_settings')
        .upsert({
          setting_key: 'api_keys',
          setting_value: newApiKeys as any,
          description: 'API keys configuration',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'setting_key' });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });

  const generateApiKey = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let key = 'sk_live_';
    for (let i = 0; i < 32; i++) {
      key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return key;
  };

  const maskPreview = (v: string) => (v.length <= 8 ? "••••••••" : `${v.slice(0, 4)}••••${v.slice(-4)}`);

  const handleCreateIntegration = async () => {
    if (!integrationForm.name || !integrationForm.provider) {
      toast({ title: "Name and provider are required", variant: "destructive" });
      return;
    }

    const integrationId = editingIntegration?.id || crypto.randomUUID();
    const rawSecrets: Record<string, string> = {};
    if (integrationForm.api_key && !integrationForm.api_key.includes("••••")) rawSecrets.api_key = integrationForm.api_key;
    if (integrationForm.api_secret && !integrationForm.api_secret.includes("••••")) rawSecrets.api_secret = integrationForm.api_secret;

    // Persist raw secrets to the service-role vault via edge function; never store plaintext in admin_settings.
    if (Object.keys(rawSecrets).length) {
      const { error: vaultErr } = await supabase.functions.invoke('admin-integration-secrets', {
        body: { namespace: 'integration', owner_id: integrationId, secrets: rawSecrets },
      });
      if (vaultErr) {
        toast({ title: "Failed to store secrets securely", description: vaultErr.message, variant: "destructive" });
        return;
      }
    }

    const existingApiKeyPreview = editingIntegration?.api_key ?? null;
    const existingApiSecretPreview = editingIntegration?.api_secret ?? null;

    const newIntegration: Integration = {
      id: integrationId,
      name: integrationForm.name,
      provider: integrationForm.provider,
      type: integrationForm.type,
      status: integrationForm.status,
      api_key: rawSecrets.api_key ? maskPreview(rawSecrets.api_key) : existingApiKeyPreview,
      api_secret: rawSecrets.api_secret ? maskPreview(rawSecrets.api_secret) : existingApiSecretPreview,
      webhook_url: integrationForm.webhook_url || null,
      config: integrationForm.config,
      last_sync: null,
      error_message: null,
      created_at: editingIntegration?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const updatedIntegrations = editingIntegration
      ? integrations.map(i => i.id === editingIntegration.id ? newIntegration : i)
      : [...integrations, newIntegration];

    saveIntegrationsMutation.mutate(updatedIntegrations);
    toast({ title: editingIntegration ? "Integration updated" : "Integration created" });
    resetIntegrationForm();
  };

  const handleDeleteIntegration = async (id: string) => {
    // Purge secrets from vault too.
    await supabase.functions.invoke('admin-integration-secrets', {
      body: { namespace: 'integration', owner_id: id, action: 'delete_owner' },
    });
    const updatedIntegrations = integrations.filter(i => i.id !== id);
    saveIntegrationsMutation.mutate(updatedIntegrations);
    toast({ title: "Integration deleted" });
  };

  const handleToggleIntegration = (id: string, status: 'active' | 'inactive') => {
    const updatedIntegrations = integrations.map(i => 
      i.id === id ? { ...i, status, updated_at: new Date().toISOString() } : i
    );
    saveIntegrationsMutation.mutate(updatedIntegrations);
    toast({ title: `Integration ${status === 'active' ? 'activated' : 'deactivated'}` });
  };

  const handleCreateApiKey = () => {
    if (!apiKeyForm.name) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }

    const key = generateApiKey();
    const newApiKey: ApiKey = {
      id: crypto.randomUUID(),
      name: apiKeyForm.name,
      key: key,
      prefix: key.substring(0, 12) + '...',
      permissions: apiKeyForm.permissions,
      rate_limit: apiKeyForm.rate_limit,
      is_active: true,
      last_used: null,
      expires_at: apiKeyForm.expires_at || null,
      created_at: new Date().toISOString(),
    };

    saveApiKeysMutation.mutate([...apiKeys, newApiKey]);
    setNewApiKey(key);
    toast({ title: "API key created", description: "Make sure to copy your key now. You won't be able to see it again." });
  };

  const handleDeleteApiKey = (id: string) => {
    const updatedKeys = apiKeys.filter(k => k.id !== id);
    saveApiKeysMutation.mutate(updatedKeys);
    toast({ title: "API key deleted" });
  };

  const handleToggleApiKey = (id: string, is_active: boolean) => {
    const updatedKeys = apiKeys.map(k => 
      k.id === id ? { ...k, is_active } : k
    );
    saveApiKeysMutation.mutate(updatedKeys);
    toast({ title: `API key ${is_active ? 'activated' : 'deactivated'}` });
  };

  const resetIntegrationForm = () => {
    setIntegrationForm({
      name: "",
      provider: "",
      type: "api",
      api_key: "",
      api_secret: "",
      webhook_url: "",
      config: {},
      status: "active",
    });
    setEditingIntegration(null);
    setIsIntegrationDialogOpen(false);
  };

  const resetApiKeyForm = () => {
    setApiKeyForm({
      name: "",
      permissions: [],
      rate_limit: 1000,
      expires_at: "",
    });
    setNewApiKey(null);
    setIsApiKeyDialogOpen(false);
  };

  const handleEditIntegration = (integration: Integration) => {
    setEditingIntegration(integration);
    setIntegrationForm({
      name: integration.name,
      provider: integration.provider,
      type: integration.type,
      // Secrets are stored in the service-role vault, never returned to the client.
      // Leave the fields blank so admins must re-enter to change them.
      api_key: "",
      api_secret: "",
      webhook_url: integration.webhook_url || "",
      config: integration.config,
      status: integration.status === 'error' ? 'inactive' : integration.status,
    });
    setIsIntegrationDialogOpen(true);
  };

  const togglePermission = (permission: string) => {
    const current = apiKeyForm.permissions;
    const newPermissions = current.includes(permission)
      ? current.filter(p => p !== permission)
      : [...current, permission];
    setApiKeyForm({ ...apiKeyForm, permissions: newPermissions });
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied to clipboard" });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return <Badge className="bg-green-500/10 text-green-600 border-green-500/30"><CheckCircle className="mr-1 h-3 w-3" />Active</Badge>;
      case 'inactive':
        return <Badge variant="secondary"><XCircle className="mr-1 h-3 w-3" />Inactive</Badge>;
      case 'error':
        return <Badge variant="destructive"><AlertTriangle className="mr-1 h-3 w-3" />Error</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getProviderInfo = (provider: string) => {
    return INTEGRATION_PROVIDERS.find(p => p.value === provider) || { icon: '🔧', label: provider };
  };

  const filteredIntegrations = integrations.filter(i => 
    i.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    i.provider.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <section className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold">API &amp; Integration tools</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Manage third-party integrations, programmatic API keys, and API documentation.
        </p>
      </div>

      {/* Integrations */}
      <div className="space-y-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <h3 className="text-base font-semibold flex items-center gap-2">
            <Zap className="h-4 w-4" />
            Integrations
          </h3>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search integrations..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Button onClick={() => { resetIntegrationForm(); setIsIntegrationDialogOpen(true); }}>
              <Plus className="mr-2 h-4 w-4" />
              Add Integration
            </Button>
          </div>
        </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {filteredIntegrations.map((integration) => {
                const provider = getProviderInfo(integration.provider);
                return (
                  <Card key={integration.id} className="relative">
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-3">
                          <div className="text-2xl">{provider.icon}</div>
                          <div>
                            <CardTitle className="text-base">{integration.name}</CardTitle>
                            <CardDescription>{provider.label}</CardDescription>
                          </div>
                        </div>
                        {getStatusBadge(integration.status)}
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {integration.api_key && (
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">API Key</span>
                          <div className="flex items-center gap-2">
                            <code className="bg-muted px-2 py-0.5 rounded text-xs">
                              {showSecrets[integration.id] ? integration.api_key : '••••••••••••'}
                            </code>
                            <Button 
                              variant="ghost" 
                              size="icon" 
                              className="h-6 w-6"
                              onClick={() => setShowSecrets(prev => ({ ...prev, [integration.id]: !prev[integration.id] }))}
                            >
                              {showSecrets[integration.id] ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                            </Button>
                          </div>
                        </div>
                      )}
                      {integration.last_sync && (
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Last Sync</span>
                          <span>{format(new Date(integration.last_sync), 'MMM d, HH:mm')}</span>
                        </div>
                      )}
                      {integration.error_message && (
                        <div className="text-xs text-destructive bg-destructive/10 p-2 rounded">
                          {integration.error_message}
                        </div>
                      )}
                      <div className="flex gap-2 pt-2">
                        <Button 
                          variant="outline" 
                          size="sm" 
                          className="flex-1"
                          onClick={() => handleEditIntegration(integration)}
                        >
                          <Settings2 className="mr-1 h-3 w-3" />
                          Configure
                        </Button>
                        <Button
                          variant={integration.status === 'active' ? 'secondary' : 'default'}
                          size="sm"
                          onClick={() => handleToggleIntegration(
                            integration.id, 
                            integration.status === 'active' ? 'inactive' : 'active'
                          )}
                        >
                          {integration.status === 'active' ? <Unlink className="h-3 w-3" /> : <Link2 className="h-3 w-3" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteIntegration(integration.id)}
                        >
                          <Trash2 className="h-3 w-3 text-destructive" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}

              {filteredIntegrations.length === 0 && (
                <Card className="col-span-full">
                  <CardContent className="flex flex-col items-center justify-center py-10">
                    <Zap className="h-12 w-12 text-muted-foreground mb-4" />
                    <p className="text-muted-foreground">No integrations configured yet</p>
                    <Button 
                      variant="outline" 
                      className="mt-4"
                      onClick={() => { resetIntegrationForm(); setIsIntegrationDialogOpen(true); }}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Add your first integration
                    </Button>
                  </CardContent>
                </Card>
              )}
            </div>
      </div>

      {/* API Keys */}
      <div className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <h3 className="text-base font-semibold flex items-center gap-2">
            <Key className="h-4 w-4" />
            API Keys
          </h3>
          <Button onClick={() => { resetApiKeyForm(); setIsApiKeyDialogOpen(true); }}>
            <Plus className="mr-2 h-4 w-4" />
            Generate API Key
          </Button>
        </div>

            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>Permissions</TableHead>
                    <TableHead>Rate Limit</TableHead>
                    <TableHead>Last Used</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-[100px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {apiKeys.map((key) => (
                    <TableRow key={key.id}>
                      <TableCell className="font-medium">{key.name}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <code className="bg-muted px-2 py-1 rounded text-xs">{key.prefix}</code>
                          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => copyToClipboard(key.key)}>
                            <Copy className="h-3 w-3" />
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {key.permissions.slice(0, 2).map((p) => (
                            <Badge key={p} variant="outline" className="text-xs">{p}</Badge>
                          ))}
                          {key.permissions.length > 2 && (
                            <Badge variant="outline" className="text-xs">+{key.permissions.length - 2}</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>{key.rate_limit}/hr</TableCell>
                      <TableCell>
                        {key.last_used ? format(new Date(key.last_used), 'MMM d, HH:mm') : 'Never'}
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={key.is_active}
                          onCheckedChange={(checked) => handleToggleApiKey(key.id, checked)}
                        />
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDeleteApiKey(key.id)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {apiKeys.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-10 text-muted-foreground">
                        No API keys generated yet
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Card>
      </div>

      {/* API Documentation */}
      <div className="space-y-4">
        <h3 className="text-base font-semibold flex items-center gap-2">
          <Code className="h-4 w-4" />
          API Docs
        </h3>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Code className="h-5 w-5" />
                  API Reference
                </CardTitle>
                <CardDescription>Quick reference for the OneCab API</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <h3 className="font-semibold mb-2">Base URL</h3>
                  <div className="flex items-center gap-2">
                    <code className="bg-muted px-3 py-2 rounded flex-1">
                      https://api.onecab.com/v1
                    </code>
                    <Button variant="outline" size="icon" onClick={() => copyToClipboard('https://api.onecab.com/v1')}>
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold mb-2">Authentication</h3>
                  <p className="text-sm text-muted-foreground mb-2">
                    Include your API key in the Authorization header:
                  </p>
                  <code className="bg-muted px-3 py-2 rounded block text-sm">
                    Authorization: Bearer sk_live_xxxxxxxxxxxxx
                  </code>
                </div>

                <div>
                  <h3 className="font-semibold mb-3">Endpoints</h3>
                  <div className="space-y-3">
                    {[
                      { method: 'GET', path: '/trips', description: 'List all trips' },
                      { method: 'POST', path: '/trips', description: 'Create a new trip' },
                      { method: 'GET', path: '/trips/:id', description: 'Get trip details' },
                      { method: 'GET', path: '/drivers', description: 'List all drivers' },
                      { method: 'GET', path: '/drivers/:id/location', description: 'Get driver location' },
                      { method: 'POST', path: '/fare/estimate', description: 'Estimate fare' },
                      { method: 'GET', path: '/webhooks', description: 'List webhooks' },
                      { method: 'POST', path: '/webhooks', description: 'Create webhook' },
                    ].map((endpoint, i) => (
                      <div key={i} className="flex items-center gap-3 p-2 rounded border">
                        <Badge variant={endpoint.method === 'GET' ? 'secondary' : 'default'} className="font-mono">
                          {endpoint.method}
                        </Badge>
                        <code className="text-sm flex-1">{endpoint.path}</code>
                        <span className="text-sm text-muted-foreground">{endpoint.description}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button variant="outline" className="gap-2">
                    <ExternalLink className="h-4 w-4" />
                    Full Documentation
                  </Button>
                  <Button variant="outline" className="gap-2">
                    <Code className="h-4 w-4" />
                    OpenAPI Spec
                  </Button>
                </div>
              </CardContent>
            </Card>
      </div>

      {/* Integration Dialog */}
        <Dialog open={isIntegrationDialogOpen} onOpenChange={setIsIntegrationDialogOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{editingIntegration ? "Edit Integration" : "Add Integration"}</DialogTitle>
              <DialogDescription>Configure a third-party service integration</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label>Integration Name *</Label>
                <Input
                  value={integrationForm.name}
                  onChange={(e) => setIntegrationForm({ ...integrationForm, name: e.target.value })}
                  placeholder="e.g., Production Provider"
                />
              </div>
              <div className="grid gap-2">
                <Label>Provider *</Label>
                <Select
                  value={integrationForm.provider}
                  onValueChange={(value) => setIntegrationForm({ ...integrationForm, provider: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {INTEGRATION_PROVIDERS.map((provider) => (
                      <SelectItem key={provider.value} value={provider.value}>
                        <div className="flex items-center gap-2">
                          <span>{provider.icon}</span>
                          <span>{provider.label}</span>
                          <span className="text-muted-foreground text-xs">- {provider.description}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>API Key</Label>
                <Input
                  type="password"
                  value={integrationForm.api_key}
                  onChange={(e) => setIntegrationForm({ ...integrationForm, api_key: e.target.value })}
                  placeholder="Enter API key"
                />
              </div>
              <div className="grid gap-2">
                <Label>API Secret</Label>
                <Input
                  type="password"
                  value={integrationForm.api_secret}
                  onChange={(e) => setIntegrationForm({ ...integrationForm, api_secret: e.target.value })}
                  placeholder="Enter API secret (if required)"
                />
              </div>
              <div className="grid gap-2">
                <Label>Webhook URL</Label>
                <Input
                  value={integrationForm.webhook_url}
                  onChange={(e) => setIntegrationForm({ ...integrationForm, webhook_url: e.target.value })}
                  placeholder="https://..."
                />
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <Label>Active</Label>
                  <p className="text-xs text-muted-foreground">Enable this integration</p>
                </div>
                <Switch
                  checked={integrationForm.status === 'active'}
                  onCheckedChange={(checked) => setIntegrationForm({ ...integrationForm, status: checked ? 'active' : 'inactive' })}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={resetIntegrationForm}>Cancel</Button>
              <Button onClick={handleCreateIntegration}>
                {editingIntegration ? "Update" : "Create"} Integration
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* API Key Dialog */}
        <Dialog open={isApiKeyDialogOpen} onOpenChange={(open) => { if (!open) resetApiKeyForm(); else setIsApiKeyDialogOpen(true); }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Generate API Key</DialogTitle>
              <DialogDescription>Create a new API key for programmatic access</DialogDescription>
            </DialogHeader>
            {newApiKey ? (
              <div className="space-y-4 py-4">
                <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <CheckCircle className="h-5 w-5 text-green-600" />
                    <span className="font-semibold text-green-600">API Key Generated!</span>
                  </div>
                  <p className="text-sm text-muted-foreground mb-3">
                    Make sure to copy your API key now. You won't be able to see it again!
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="bg-muted px-3 py-2 rounded flex-1 text-sm break-all">{newApiKey}</code>
                    <Button variant="outline" size="icon" onClick={() => copyToClipboard(newApiKey)}>
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                  <Label>Key Name *</Label>
                  <Input
                    value={apiKeyForm.name}
                    onChange={(e) => setApiKeyForm({ ...apiKeyForm, name: e.target.value })}
                    placeholder="e.g., Production API Key"
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Permissions</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {PERMISSION_OPTIONS.map((perm) => (
                      <div
                        key={perm.value}
                        className={`flex items-center gap-2 p-2 rounded border cursor-pointer transition-colors ${
                          apiKeyForm.permissions.includes(perm.value) ? 'border-primary bg-primary/5' : 'hover:bg-accent'
                        }`}
                        onClick={() => togglePermission(perm.value)}
                      >
                        <div className={`h-4 w-4 rounded border flex items-center justify-center ${
                          apiKeyForm.permissions.includes(perm.value) ? 'bg-primary border-primary' : ''
                        }`}>
                          {apiKeyForm.permissions.includes(perm.value) && (
                            <CheckCircle className="h-3 w-3 text-primary-foreground" />
                          )}
                        </div>
                        <span className="text-sm">{perm.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label>Rate Limit (per hour)</Label>
                    <Input
                      type="number"
                      value={apiKeyForm.rate_limit}
                      onChange={(e) => setApiKeyForm({ ...apiKeyForm, rate_limit: parseInt(e.target.value) || 1000 })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>Expires At</Label>
                    <Input
                      type="date"
                      value={apiKeyForm.expires_at}
                      onChange={(e) => setApiKeyForm({ ...apiKeyForm, expires_at: e.target.value })}
                    />
                  </div>
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={resetApiKeyForm}>
                {newApiKey ? "Done" : "Cancel"}
              </Button>
              {!newApiKey && (
                <Button onClick={handleCreateApiKey}>
                  <Key className="mr-2 h-4 w-4" />
                  Generate Key
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
    </section>
  );
}