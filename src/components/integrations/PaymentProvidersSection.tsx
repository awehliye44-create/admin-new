import { useState } from "react";
import { format } from "date-fns";
import {
  AlertTriangle,
  CheckCircle,
  Loader2,
  RefreshCw,
  Shield,
  TestTube2,
  Webhook,
  XCircle,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  CRITICAL_BUTTON_TIMEOUT_MESSAGE,
  useCriticalButtonTimeout,
} from "@/lib/criticalButtonTimeout";
import { startAdminPerformanceStep } from "@/lib/recordAdminPerformanceStep";
import {
  type PaymentProviderCard,
  type PaymentProviderId,
  type ProviderEnvironment,
  usePaymentProviders,
} from "@/hooks/usePaymentProviders";

function dedupeConnectionToastLines(lines: string[]): string[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    const normalized = line.toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) return false;
    for (const prior of seen) {
      if (prior.includes(normalized) || normalized.includes(prior)) return false;
    }
    seen.add(normalized);
    return true;
  });
}
import { PROVIDER_SECRET_FIELD_LABELS, PROVIDER_SECRET_FIELDS } from "@/lib/paymentProviderConfig";
import { PROVIDER_NOT_IMPLEMENTED_CODE } from "@/lib/customerPaymentWorkflow";

const PROVIDER_ICONS: Record<PaymentProviderId, string> = {
  stripe: "💳",
  checkout_com: "🛒",
  adyen: "🏦",
  worldpay: "🌐",
  braintree: "💰",
  sifalo_pay: "🇸🇴",
  waafi_pay: "📱",
  sahal_pay: "🕌",
  intasend: "🇰🇪",
  paystack: "🇳🇬",
  flutterwave: "🦋",
  pesapal: "🇰🇪",
  hubtel: "🇬🇭",
  dpo_pay: "🌍",
  noda: "🏦",
  revolut: "💷",
};

function statusBadge(provider: PaymentProviderCard) {
  if (provider.credentials_ready && provider.booking_adapter_status === "not_implemented") {
    return (
      <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-800 dark:text-amber-200">
        <CheckCircle className="h-3 w-3" />
        Credentials ready
      </Badge>
    );
  }
  const map = {
    not_configured: { label: "Not configured", variant: "secondary" as const, icon: XCircle },
    connected: { label: "Connected", variant: "outline" as const, icon: CheckCircle },
    error: { label: "Error", variant: "destructive" as const, icon: AlertTriangle },
    live: { label: "Live", variant: "default" as const, icon: CheckCircle },
    test: { label: "Test", variant: "outline" as const, icon: TestTube2 },
  };
  const cfg = map[provider.status] ?? map.not_configured;
  const Icon = cfg.icon;
  return (
    <Badge variant={cfg.variant} className="gap-1">
      <Icon className="h-3 w-3" />
      {cfg.label}
    </Badge>
  );
}

function bookingAdapterBadge(status: PaymentProviderCard["booking_adapter_status"]) {
  if (status === "live") {
    return <Badge className="bg-green-500/10 text-green-700 border-green-500/30">Booking adapter live</Badge>;
  }
  if (status === "not_implemented") {
    return (
      <Badge variant="secondary" className="font-mono text-xs">
        {PROVIDER_NOT_IMPLEMENTED_CODE}
      </Badge>
    );
  }
  return <Badge variant="secondary">Adapter not configured</Badge>;
}

function payoutAdapterBadge(status: PaymentProviderCard["payout_adapter_status"]) {
  if (status === "live") {
    return <Badge className="bg-green-500/10 text-green-700 border-green-500/30">Payout adapter live</Badge>;
  }
  if (status === "not_implemented") {
    return (
      <Badge variant="secondary" className="font-mono text-xs">
        Payout {PROVIDER_NOT_IMPLEMENTED_CODE}
      </Badge>
    );
  }
  return <Badge variant="secondary">Payout adapter not configured</Badge>;
}

function webhookSecretBadge(status: "added" | "missing" | undefined) {
  if (status === "added") {
    return <Badge variant="outline">Stored</Badge>;
  }
  return <Badge variant="secondary">Missing</Badge>;
}

function webhookBadge(status: PaymentProviderCard["webhook_status"]) {
  if (status === "healthy") {
    return <Badge className="bg-green-500/10 text-green-700 border-green-500/30">Healthy</Badge>;
  }
  if (status === "failing") {
    return <Badge variant="destructive">Failing</Badge>;
  }
  return <Badge variant="secondary">Not configured</Badge>;
}

function SecretsDialog({
  provider,
  open,
  onOpenChange,
  mode,
  onSave,
  isSaving,
}: {
  provider: PaymentProviderCard;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  mode: ProviderEnvironment;
  onSave: (secrets: Record<string, string>) => void;
  isSaving: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>({});

  const fields = PROVIDER_SECRET_FIELDS[provider.provider] ?? [
    "publishable_key",
    "secret_key",
    "webhook_secret",
    "merchant_id",
  ];
  const labels = PROVIDER_SECRET_FIELD_LABELS[provider.provider] ?? {};

  const handleSave = () => {
    onSave(values);
    setValues({});
    onOpenChange(false);
  };

  const setField = (name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {provider.display_name} secrets</DialogTitle>
          <DialogDescription>
            Secrets are stored securely server-side. Only masked values are shown in the admin UI.
            Leave fields blank to keep existing values.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {fields.map((fieldName) => {
            const label = labels[fieldName] ?? fieldName;
            const isSecret = fieldName === "secret_key" || fieldName === "webhook_secret";
            const masked = provider.secrets?.[fieldName as keyof typeof provider.secrets];
            return (
              <div key={fieldName} className="space-y-2">
                <Label>
                  {label} ({mode})
                </Label>
                <Input
                  type={isSecret ? "password" : "text"}
                  placeholder={masked ?? `${label}…`}
                  value={values[fieldName] ?? ""}
                  onChange={(e) => setField(fieldName, e.target.value)}
                  autoComplete={isSecret ? "new-password" : "off"}
                />
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save secrets
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProviderCard({
  provider,
  onToggleEnabled,
  onTogglePrimary,
  onToggleMode,
  onTest,
  onEditSecrets,
  isTesting,
}: {
  provider: PaymentProviderCard;
  onToggleEnabled: (enabled: boolean) => void;
  onTogglePrimary: () => void;
  onToggleMode: (mode: ProviderEnvironment) => void;
  onTest: () => void;
  onEditSecrets: () => void;
  isTesting: boolean;
}) {
  const isStripe = provider.provider === "stripe";

  return (
    <Card className={provider.is_primary ? "border-primary/50 shadow-sm" : undefined}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="text-2xl">{PROVIDER_ICONS[provider.provider]}</div>
            <div>
              <CardTitle className="text-lg">{provider.display_name}</CardTitle>
              <CardDescription>Payment Provider</CardDescription>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            {statusBadge(provider)}
            {bookingAdapterBadge(provider.booking_adapter_status)}
            {payoutAdapterBadge(provider.payout_adapter_status)}
            <Badge variant="outline">{provider.mode === "live" ? "Live" : "Test"} mode</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {(provider.warnings ?? []).map((w) => (
          <Alert
            key={w}
            variant={w.startsWith("Critical") ? "destructive" : "default"}
            className={w.includes("webhook failing") ? "border-destructive/50 bg-destructive/5" : undefined}
          >
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{w}</AlertDescription>
          </Alert>
        ))}

        {provider.last_error_message ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Connection test failed</AlertTitle>
            <AlertDescription className="whitespace-pre-wrap">{provider.last_error_message}</AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-2 text-sm md:grid-cols-2">
          <div className="flex justify-between">
            <span className="text-muted-foreground">API key</span>
            <span>{provider.api_key_status === "added" ? "Added" : "Missing"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">
              {isStripe ? "Webhook health" : "Webhook secret"}
            </span>
            {isStripe ? webhookBadge(provider.webhook_status) : webhookSecretBadge(provider.webhook_secret_status)}
          </div>
          {provider.last_webhook_received && (
            <div className="flex justify-between md:col-span-2">
              <span className="text-muted-foreground">Last webhook received</span>
              <span>{format(new Date(provider.last_webhook_received), "MMM d, HH:mm:ss")}</span>
            </div>
          )}
          {provider.last_successful_event && (
            <div className="flex justify-between md:col-span-2">
              <span className="text-muted-foreground">Last successful event</span>
              <span className="text-right">
                {provider.last_successful_event.event_type}
                <span className="text-muted-foreground ml-1">
                  ({format(new Date(provider.last_successful_event.at), "HH:mm")})
                </span>
              </span>
            </div>
          )}
          {provider.last_failed_event && (
            <div className="flex justify-between md:col-span-2">
              <span className="text-muted-foreground">Last failed event</span>
              <span className="text-destructive text-right">
                {provider.last_failed_event.event_type}
              </span>
            </div>
          )}
        </div>

        {isStripe && (
          <div className="rounded-lg border bg-muted/30 p-3 space-y-2 text-sm">
            <p className="font-medium flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Provider technical configuration
            </p>
            <div className="grid gap-1.5">
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground shrink-0">Publishable key</span>
                <code className="text-xs">{provider.secrets.publishable_key ?? "—"}</code>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground shrink-0">Secret key</span>
                <code className="text-xs">{provider.secrets.secret_key ?? "—"}</code>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground shrink-0">Webhook secret</span>
                <code className="text-xs">{provider.secrets.webhook_secret ?? "—"}</code>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground shrink-0">Webhook URL</span>
                <code className="text-xs break-all text-right">{provider.webhook_endpoint_url}</code>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Connect enabled</span>
                <span>{provider.connect_enabled === false ? "No" : "Yes"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Apple Pay enabled</span>
                <span>{provider.apple_pay_enabled ? "Yes" : "No"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Google Pay enabled</span>
                <span>{provider.google_pay_enabled ? "Yes" : "No"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Health status</span>
                {webhookBadge(provider.webhook_status)}
              </div>
            </div>
          </div>
        )}

        {provider.webhook_health && (
          <div className="rounded-lg border p-3 space-y-3">
            <p className="font-medium flex items-center gap-2 text-sm">
              <Webhook className="h-4 w-4" />
              Webhook health panel
            </p>
            <div className="grid gap-1 text-sm md:grid-cols-2">
              <div className="md:col-span-2 flex justify-between gap-4">
                <span className="text-muted-foreground">Endpoint URL</span>
                <code className="text-xs break-all text-right">{provider.webhook_health.endpoint_url}</code>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status</span>
                {webhookBadge(provider.webhook_status)}
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Success (24h)</span>
                <span>{provider.webhook_health.success_count_24h}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Failures (24h)</span>
                <span className={provider.webhook_health.failure_count_24h > 0 ? "text-destructive" : ""}>
                  {provider.webhook_health.failure_count_24h}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Retry count</span>
                <span>{provider.webhook_health.retry_count}</span>
              </div>
              {provider.webhook_health.last_error_message && (
                <div className="md:col-span-2 text-xs text-destructive bg-destructive/10 p-2 rounded">
                  {provider.webhook_health.last_error_message}
                </div>
              )}
            </div>
            {(provider.webhook_health?.recent_events ?? []).length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Event</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Received</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(provider.webhook_health?.recent_events ?? []).map((e) => (
                    <TableRow key={e.event_id}>
                      <TableCell className="text-xs">{e.event_type}</TableCell>
                      <TableCell>
                        <Badge
                          variant={e.status.startsWith("failed") ? "destructive" : "outline"}
                          className="text-xs"
                        >
                          {e.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {format(new Date(e.processed_at), "MMM d HH:mm")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-4 pt-2 border-t">
          <div className="flex items-center gap-2">
            <Switch
              checked={provider.is_primary}
              onCheckedChange={() => onTogglePrimary()}
              disabled={!provider.is_enabled}
            />
            <Label className="text-sm">Primary provider</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={provider.is_enabled}
              onCheckedChange={onToggleEnabled}
            />
            <Label className="text-sm">Enabled</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={provider.mode === "live"}
              onCheckedChange={(live) => onToggleMode(live ? "live" : "test")}
            />
            <Label className="text-sm">{provider.mode === "live" ? "Live" : "Test"}</Label>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onEditSecrets}>
            Edit secrets
          </Button>
          <Button variant="outline" size="sm" onClick={onTest} disabled={isTesting}>
            {isTesting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Test connection
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function PaymentProvidersConfigurationReadiness({
  globalWarnings,
  activeProvider,
}: {
  globalWarnings: string[];
  activeProvider: string;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Configuration Readiness</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Prepare provider credentials before go-live. Service area gateway assignment is under each
          Service Area → Offers &amp; Payment.
        </p>
      </div>

      <Alert>
        <Shield className="h-4 w-4" />
        <AlertTitle>Configuration readiness phase</AlertTitle>
        <AlertDescription>
          Use this page to prepare API keys, secrets, and test/live mode before vendors deliver
          credentials. Milton Keynes remains Provider (customer) and Provider (driver) — unchanged.
          Service area gateway and mobile wallet allowlists are configured under each Service Area →
          Offers & Payment.
        </AlertDescription>
      </Alert>

      <p className="text-sm text-muted-foreground">
        Active primary provider: <strong>{activeProvider.replace(/_/g, " ")}</strong>
      </p>

      {globalWarnings.some((w) => w.includes("webhook failing")) && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Payment provider webhook failing</AlertTitle>
          <AlertDescription>
            Finance and payout statuses may be delayed until webhook delivery is restored.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

export function PaymentProvidersCardsGrid() {
  const { toast } = useToast();
  const { data, isLoading, refetch, updateProvider, saveSecrets, testConnection } = usePaymentProviders();
  const saveProviderTimeout = useCriticalButtonTimeout({
    action: "admin_save_provider",
    isPending: saveSecrets.isPending,
    onTimeout: () => {
      toast({
        title: "Please try again",
        description: CRITICAL_BUTTON_TIMEOUT_MESSAGE,
        variant: "destructive",
      });
    },
  });
  const [secretsProvider, setSecretsProvider] = useState<PaymentProviderCard | null>(null);
  const [testingProvider, setTestingProvider] = useState<PaymentProviderId | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const providers = data?.providers ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Payment Providers</h2>
          <p className="text-sm text-muted-foreground">
            Store provider credentials and webhook secrets now. Adding keys does not make a provider live —
            only Provider has a live booking adapter today. Other providers return{" "}
            <code className="text-xs">{PROVIDER_NOT_IMPLEMENTED_CODE}</code> until adapter, webhook
            processing, sandbox testing, and production approval are complete.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {providers.map((provider) => (
          <ProviderCard
            key={provider.provider}
            provider={provider}
            isTesting={testingProvider === provider.provider}
            onToggleEnabled={(enabled) => {
              updateProvider.mutate(
                { provider: provider.provider, is_enabled: enabled },
                {
                  onSuccess: () => toast({ title: enabled ? "Provider enabled" : "Provider disabled" }),
                  onError: (e) => toast({ title: "Update failed", description: e.message, variant: "destructive" }),
                },
              );
            }}
            onTogglePrimary={() => {
              updateProvider.mutate(
                { provider: provider.provider, is_primary: true, is_enabled: true },
                {
                  onSuccess: () => toast({ title: `${provider.display_name} set as primary provider` }),
                  onError: (e) => toast({ title: "Update failed", description: e.message, variant: "destructive" }),
                },
              );
            }}
            onToggleMode={(mode) => {
              updateProvider.mutate(
                { provider: provider.provider, environment: mode },
                {
                  onSuccess: () => toast({ title: `Mode set to ${mode}` }),
                  onError: (e) => toast({ title: "Update failed", description: e.message, variant: "destructive" }),
                },
              );
            }}
            onTest={() => {
              setTestingProvider(provider.provider);
              testConnection.mutate(
                { provider: provider.provider, environment: provider.mode },
                {
                  onSuccess: (result: {
                    ok: boolean;
                    message: string;
                    provider?: string;
                    mode?: string;
                    http_status?: number;
                    http_status_label?: string;
                    provider_error_code?: string | null;
                    provider_error_message?: string | null;
                    revolut_error_code?: string | null;
                    revolut_message?: string | null;
                    api_surface?: string;
                    endpoint_tested?: string;
                    warnings?: string[];
                  }) => {
                    const errorCode = result.provider_error_code ?? result.revolut_error_code;
                    const errorMessage = result.provider_error_message ?? result.revolut_message;
                    const primaryMessage = result.message?.trim() ?? "";
                    const lines = dedupeConnectionToastLines([
                      primaryMessage,
                      result.http_status && !primaryMessage.includes(String(result.http_status))
                        ? `HTTP ${result.http_status} ${result.http_status_label ?? ""}`.trim()
                        : null,
                      errorCode && !primaryMessage.includes(String(errorCode))
                        ? `Code: ${errorCode}`
                        : null,
                      errorMessage && errorMessage !== primaryMessage && !primaryMessage.includes(errorMessage)
                        ? errorMessage
                        : null,
                      result.api_surface && !primaryMessage.toLowerCase().includes(result.api_surface)
                        ? `API: ${result.api_surface}`
                        : null,
                      result.endpoint_tested && !primaryMessage.includes(result.endpoint_tested)
                        ? `Endpoint: ${result.endpoint_tested}`
                        : null,
                      ...(result.warnings ?? []),
                    ].filter(Boolean) as string[]);
                    toast({
                      title: result.ok ? "Connection successful" : "Connection failed",
                      description: lines.join("\n"),
                      variant: result.ok ? "default" : "destructive",
                    });
                  },
                  onError: (e) => toast({ title: "Test failed", description: e.message, variant: "destructive" }),
                  onSettled: () => setTestingProvider(null),
                },
              );
            }}
            onEditSecrets={() => setSecretsProvider(provider)}
          />
        ))}
      </div>

      {secretsProvider && (
        <SecretsDialog
          provider={secretsProvider}
          open={!!secretsProvider}
          onOpenChange={(open) => !open && setSecretsProvider(null)}
          mode={secretsProvider.mode}
          isSaving={saveProviderTimeout.showSpinner}
          onSave={(secrets) => {
            const perf = startAdminPerformanceStep({ action_name: "admin_save_provider" });
            saveSecrets.mutate(
              {
                provider: secretsProvider.provider,
                environment: secretsProvider.mode,
                secrets,
              },
              {
                onSuccess: () => {
                  perf.complete({ success: true });
                  toast({ title: "Secrets saved securely" });
                },
                onError: (e) => {
                  perf.complete({ success: false, error_code: "save_failed" });
                  toast({ title: "Save failed", description: e.message, variant: "destructive" });
                },
              },
            );
          }}
        />
      )}
    </div>
  );
}

/** @deprecated Use PaymentProvidersConfigurationReadiness + PaymentProvidersCardsGrid on the SSOT page. */
export function PaymentProvidersSection() {
  const { data, isLoading } = usePaymentProviders();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const globalWarnings = data?.global_warnings ?? [];
  const activeProvider = data?.active_provider ?? "stripe";

  return (
    <div className="space-y-6">
      <PaymentProvidersConfigurationReadiness
        globalWarnings={globalWarnings}
        activeProvider={activeProvider}
      />
      <PaymentProvidersCardsGrid />
    </div>
  );
}
