import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { MobileWalletMethodId } from '@/lib/customerPaymentWorkflow';

export type StripeDigitalPaymentMethodType = 'card' | 'wallet' | 'apple_pay' | 'google_pay';

export interface PaymentMethod {
  id: StripeDigitalPaymentMethodType;
  name: string;
  icon: string;
  platform: 'ios' | 'android' | 'all';
}

export interface ServiceAreaPaymentConfig {
  service_area_id: string;
  card_enabled: boolean;
  wallet_enabled: boolean;
  apple_pay_enabled: boolean;
  google_pay_enabled: boolean;
  mobile_wallet_methods?: MobileWalletMethodId[] | null;
}

/** Stripe card-preauth digital methods only — no cash (ONECAB is fully digital). */
export const STRIPE_DIGITAL_PAYMENT_METHODS: PaymentMethod[] = [
  { id: 'card', name: 'Card', icon: 'credit-card', platform: 'all' },
  { id: 'apple_pay', name: 'Apple Pay', icon: 'apple', platform: 'ios' },
  { id: 'google_pay', name: 'Google Pay', icon: 'smartphone', platform: 'android' },
  { id: 'wallet', name: 'ONECAB Wallet', icon: 'wallet', platform: 'all' },
];

/** @deprecated Use STRIPE_DIGITAL_PAYMENT_METHODS */
export const ALL_PAYMENT_METHODS = STRIPE_DIGITAL_PAYMENT_METHODS;

export type PaymentMethodType = StripeDigitalPaymentMethodType;

const DEFAULT_CONFIG: Omit<ServiceAreaPaymentConfig, 'service_area_id'> = {
  card_enabled: true,
  wallet_enabled: false,
  apple_pay_enabled: false,
  google_pay_enabled: false,
  mobile_wallet_methods: null,
};

export function useServiceAreaPaymentMethods(serviceAreaId?: string) {
  const [paymentConfig, setPaymentConfig] = useState<ServiceAreaPaymentConfig | null>(null);
  const [customerPaymentGateway, setCustomerPaymentGateway] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!serviceAreaId) {
      setIsLoading(false);
      return;
    }

    const fetchPaymentMethods = async () => {
      try {
        setIsLoading(true);

        const [methodsRes, areaRes] = await Promise.all([
          supabase
            .from('service_area_payment_methods')
            .select('*')
            .eq('service_area_id', serviceAreaId)
            .maybeSingle(),
          supabase
            .from('service_areas')
            .select('customer_payment_gateway')
            .eq('id', serviceAreaId)
            .maybeSingle(),
        ]);

        if (methodsRes.error && methodsRes.error.code !== 'PGRST116') {
          throw methodsRes.error;
        }
        if (areaRes.error) throw areaRes.error;

        setCustomerPaymentGateway(areaRes.data?.customer_payment_gateway ?? null);

        if (methodsRes.data) {
          setPaymentConfig(methodsRes.data as unknown as ServiceAreaPaymentConfig);
        } else {
          setPaymentConfig({
            service_area_id: serviceAreaId,
            ...DEFAULT_CONFIG,
          });
        }
      } catch (err) {
        console.error('Error fetching service area payment methods:', err);
      } finally {
        setIsLoading(false);
      }
    };

    void fetchPaymentMethods();
  }, [serviceAreaId]);

  const updatePaymentMethod = async (method: StripeDigitalPaymentMethodType, enabled: boolean) => {
    if (!serviceAreaId || !paymentConfig) return;

    const updatedConfig = {
      ...paymentConfig,
      [`${method}_enabled`]: enabled,
    };

    setPaymentConfig(updatedConfig);
    setIsSaving(true);

    try {
      const { error } = await supabase
        .from('service_area_payment_methods')
        .upsert({
          service_area_id: serviceAreaId,
          card_enabled: updatedConfig.card_enabled,
          wallet_enabled: updatedConfig.wallet_enabled,
          apple_pay_enabled: updatedConfig.apple_pay_enabled,
          google_pay_enabled: updatedConfig.google_pay_enabled,
          cash_enabled: false,
          mobile_wallet_methods: updatedConfig.mobile_wallet_methods ?? null,
        } as Record<string, unknown>, {
          onConflict: 'service_area_id',
        });

      if (error) throw error;

      await supabase
        .from('service_areas')
        .update({ updated_at: new Date().toISOString() } as Record<string, unknown>)
        .eq('id', serviceAreaId);

    } catch (err) {
      console.error('Error updating service area payment method:', err);
      setPaymentConfig(paymentConfig);
      throw err;
    } finally {
      setIsSaving(false);
    }
  };

  return {
    paymentConfig,
    customerPaymentGateway,
    isLoading,
    isSaving,
    updatePaymentMethod,
    stripeDigitalMethods: STRIPE_DIGITAL_PAYMENT_METHODS,
  };
}
