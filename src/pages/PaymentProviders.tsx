import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { AdminLayout } from "@/components/layout/AdminLayout";
import { AdminApiIntegrationToolsSection } from "@/components/integrations/AdminApiIntegrationToolsSection";
import { IntegrationsOverviewCards } from "@/components/integrations/IntegrationsOverviewCards";
import {
  PaymentProvidersCardsGrid,
  PaymentProvidersConfigurationReadiness,
} from "@/components/integrations/PaymentProvidersSection";
import { RevolutBusinessOAuthPanel } from "@/components/integrations/RevolutBusinessOAuthPanel";
import { usePaymentProviders } from "@/hooks/usePaymentProviders";

function sanitizeOAuthFlash(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 240);
  if (!cleaned) return null;
  if (/access_token|refresh_token|Bearer\s|BEGIN (RSA )?PRIVATE KEY|assertion/i.test(cleaned)) {
    return null;
  }
  return cleaned;
}

export default function PaymentProviders() {
  const { data, isLoading } = usePaymentProviders();
  const [searchParams, setSearchParams] = useSearchParams();
  const globalWarnings = data?.global_warnings ?? [];
  const activeProvider = data?.active_provider === 'stripe'
    ? 'unavailable'
    : (data?.active_provider ?? 'revolut');

  useEffect(() => {
    const flag = searchParams.get("revolut_business");
    if (!flag) return;
    const message = sanitizeOAuthFlash(searchParams.get("message"));
    const reason = sanitizeOAuthFlash(searchParams.get("reason"));
    if (flag === "connected") {
      toast.success(message ?? "Revolut Business connected. Tokens stored securely. No payments were made.");
    } else if (flag === "error") {
      toast.error(reason ? `Revolut authorization failed: ${reason}` : "Revolut authorization failed.");
    }
    const next = new URLSearchParams(searchParams);
    next.delete("revolut_business");
    next.delete("message");
    next.delete("reason");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

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

        <RevolutBusinessOAuthPanel />

        <PaymentProvidersCardsGrid />

        <AdminApiIntegrationToolsSection />
      </div>
    </AdminLayout>
  );
}
