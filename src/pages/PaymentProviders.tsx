import { AdminLayout } from "@/components/layout/AdminLayout";
import { PaymentProvidersSection } from "@/components/integrations/PaymentProvidersSection";

export default function PaymentProviders() {
  return (
    <AdminLayout title="Payment Providers">
      <PaymentProvidersSection />
    </AdminLayout>
  );
}
