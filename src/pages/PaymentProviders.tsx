import { Loader2 } from "lucide-react";
import { AdminLayout } from "@/components/layout/AdminLayout";
import { AdminApiIntegrationToolsSection } from "@/components/integrations/AdminApiIntegrationToolsSection";
import { IntegrationsOverviewCards } from "@/components/integrations/IntegrationsOverviewCards";
import {
  PaymentProvidersCardsGrid,
  PaymentProvidersConfigurationReadiness,
} from "@/components/integrations/PaymentProvidersSection";
import { usePaymentProviders } from "@/hooks/usePaymentProviders";

export default function PaymentProviders() {
  const { data, isLoading } = usePaymentProviders();
  const globalWarnings = data?.global_warnings ?? [];
  const activeProvider = data?.active_provider === 'stripe'
    ? 'unavailable'
    : (data?.active_provider ?? 'revolut');

  return (
    <AdminLayout title="Payment Providers">
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Payment Providers</h1>
          <p className="text-muted-foreground mt-1">
            Single source of truth for payment provider configuration, webhooks, and API integration tools.
          </p>
        </div>

        <IntegrationsOverviewCards />

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <PaymentProvidersConfigurationReadiness
            globalWarnings={globalWarnings}
            activeProvider={activeProvider}
          />
        )}

        <PaymentProvidersCardsGrid />

        <AdminApiIntegrationToolsSection />
      </div>
    </AdminLayout>
  );
}
