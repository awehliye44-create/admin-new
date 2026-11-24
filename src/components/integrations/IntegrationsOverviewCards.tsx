import { Activity, Code, Key, Link2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PaymentProviderCard } from "@/hooks/usePaymentProviders";

type Props = {
  /** Authoritative Payment Providers registry cards (not legacy admin_settings). */
  providers?: PaymentProviderCard[] | null;
  isLoading?: boolean;
};

/**
 * Overview counters for Settings → Payment Providers.
 * Source of truth: `payment_provider_configs` via admin-payment-providers cards.
 * Legacy `admin_settings.integrations` / `api_keys` JSON is unrelated and must not drive these figures.
 */
export function IntegrationsOverviewCards({ providers = [], isLoading = false }: Props) {
  const list = providers ?? [];
  const enabledCount = list.filter((p) => p.is_enabled).length;
  const apiKeysAdded = list.filter((p) => p.api_key_status === "added").length;
  const primary = list.find((p) => p.is_primary);

  return (
    <div className="grid gap-4 md:grid-cols-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Total Integrations</CardTitle>
          <Link2 className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{isLoading ? "—" : list.length}</div>
          <p className="text-xs text-muted-foreground">
            {isLoading ? "Loading…" : `${enabledCount} enabled`}
            {!isLoading && primary ? ` · primary ${primary.display_name}` : ""}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">API Keys</CardTitle>
          <Key className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{isLoading ? "—" : apiKeysAdded}</div>
          <p className="text-xs text-muted-foreground">
            {isLoading ? "Loading…" : `${apiKeysAdded} with credentials stored`}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Rate Limit</CardTitle>
          <Activity className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">10k/hr</div>
          <p className="text-xs text-muted-foreground">Default limit</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">API Version</CardTitle>
          <Code className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">v1.0</div>
          <p className="text-xs text-muted-foreground">Current version</p>
        </CardContent>
      </Card>
    </div>
  );
}
