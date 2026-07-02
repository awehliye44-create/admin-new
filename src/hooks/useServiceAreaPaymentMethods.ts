import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';

export type PaymentMethodType = 'card' | 'wallet' | 'apple_pay' | 'google_pay';

export interface PaymentMethod {
  id: PaymentMethodType;
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
}

export const ALL_PAYMENT_METHODS: PaymentMethod[] = [
  { id: 'card', name: 'Card', icon: 'credit-card', platform: 'all' },
  { id: 'wallet', name: 'Wallet', icon: 'wallet', platform: 'all' },
  { id: 'apple_pay', name: 'Apple Pay', icon: 'apple', platform: 'ios' },
  { id: 'google_pay', name: 'Google Pay', icon: 'smartphone', platform: 'android' },
];

const DEFAULT_CONFIG: Omit<ServiceAreaPaymentConfig, 'service_area_id'> = {
  card_enabled: true,
  wallet_enabled: false,
  apple_pay_enabled: false,
  google_pay_enabled: false,
};

export function useServiceAreaPaymentMethods(serviceAreaId?: string) {
  const [paymentConfig, setPaymentConfig] = useState<ServiceAreaPaymentConfig | null>(null);
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

        const { data, error } = await supabase
          .from('service_area_payment_methods')
          .select('*')
          .eq('service_area_id', serviceAreaId)
          .single();

        if (error && error.code !== 'PGRST116') {
          throw error;
        }

        if (data) {
          setPaymentConfig(data as unknown as ServiceAreaPaymentConfig);
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

    fetchPaymentMethods();
  }, [serviceAreaId]);

  const updatePaymentMethod = async (method: PaymentMethodType, enabled: boolean) => {
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
        } as any, {
          onConflict: 'service_area_id',
        });

      if (error) throw error;

      await supabase
        .from('service_areas')
        .update({ updated_at: new Date().toISOString() } as any)
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
    isLoading,
    isSaving,
    updatePaymentMethod,
    allPaymentMethods: ALL_PAYMENT_METHODS,
  };
}
