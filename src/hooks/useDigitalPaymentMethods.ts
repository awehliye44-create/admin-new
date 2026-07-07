import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { PaymentMethodKind, MethodReadinessState } from "@/lib/paymentMethodSSOT";
import type { PayoutAutomationStatus } from "@/lib/digitalPaymentMethodsTypes";

export type DigitalPaymentMethodRow = {
  method: PaymentMethodKind;
  enabled: boolean;
  readiness: MethodReadinessState;
  provider: string | null;
  vault_provider: string | null;
  environment: "test" | "live" | null;
  message: string | null;
};

export type DigitalPaymentMethodsPayload = {
  service_area_id: string;
  payment_provider: string | null;
  toggles: Record<string, boolean | unknown>;
  digital_payment_methods: {
    methods: DigitalPaymentMethodRow[];
    customer_collection: {
      provider: string | null;
      status: string;
      ready_for_production: boolean;
      booking_adapter_status: string;
      message: string | null;
    };
    driver_payout: {
      provider: string | null;
      status: string;
      payout_adapter_status: string;
      payout_automation: PayoutAutomationStatus;
      message: string;
    };
  };
};

export function useDigitalPaymentMethods(serviceAreaId?: string) {
  const [payload, setPayload] = useState<DigitalPaymentMethodsPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!serviceAreaId) {
      setPayload(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke(
        "admin-service-area-digital-payment-methods",
        { body: { service_area_id: serviceAreaId } },
      );
      if (fnError) throw fnError;
      if (!data?.success) {
        throw new Error(data?.error ?? "Failed to load digital payment methods");
      }
      setPayload(data as DigitalPaymentMethodsPayload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load digital payment methods";
      setError(msg);
      setPayload(null);
    } finally {
      setIsLoading(false);
    }
  }, [serviceAreaId]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateMethodToggle = useCallback(
    async (toggleField: string, enabled: boolean) => {
      if (!serviceAreaId) return;
      setIsSaving(true);
      try {
        const { data, error: fnError } = await supabase.functions.invoke(
          "admin-service-area-digital-payment-methods",
          {
            body: { service_area_id: serviceAreaId, [toggleField]: enabled },
          },
        );
        if (fnError) throw fnError;
        if (!data?.success) {
          throw new Error(data?.error ?? "Failed to update payment method");
        }
        setPayload(data as DigitalPaymentMethodsPayload);
      } catch (err) {
        console.error("updateMethodToggle failed", err);
        throw err;
      } finally {
        setIsSaving(false);
      }
    },
    [serviceAreaId],
  );

  return {
    payload,
    methods: payload?.digital_payment_methods?.methods ?? [],
    customerCollection: payload?.digital_payment_methods?.customer_collection ?? null,
    driverPayout: payload?.digital_payment_methods?.driver_payout ?? null,
    paymentProvider: payload?.payment_provider ?? null,
    isLoading,
    isSaving,
    error,
    reload: load,
    updateMethodToggle,
  };
}
