import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';

/**
 * @deprecated Region payment methods are deprecated.
 * Use useServiceAreaPaymentMethods instead - Service Area is the single source of truth for payment methods.
 */
export type PaymentMethodType = 'cash' | 'card' | 'wallet' | 'apple_pay' | 'google_pay';

export interface PaymentMethod {
  id: PaymentMethodType;
  name: string;
  icon: string;
  enabled: boolean;
  platform?: 'ios' | 'android' | 'all';
}

export interface RegionPaymentMethods {
  region_id: string;
  cash_enabled: boolean;
  card_enabled: boolean;
  wallet_enabled: boolean;
  apple_pay_enabled: boolean;
  google_pay_enabled: boolean;
}

const ALL_PAYMENT_METHODS: Omit<PaymentMethod, 'enabled'>[] = [
  { id: 'cash', name: 'Cash', icon: 'banknote', platform: 'all' },
  { id: 'card', name: 'Card', icon: 'credit-card', platform: 'all' },
  { id: 'wallet', name: 'Wallet', icon: 'wallet', platform: 'all' },
  { id: 'apple_pay', name: 'Apple Pay', icon: 'apple', platform: 'ios' },
  { id: 'google_pay', name: 'Google Pay', icon: 'smartphone', platform: 'android' },
];

// Detect platform (simplified - in real app use more robust detection)
function detectPlatform(): 'ios' | 'android' | 'web' {
  const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera;
  
  if (/iPad|iPhone|iPod/.test(userAgent) && !(window as any).MSStream) {
    return 'ios';
  }
  
  if (/android/i.test(userAgent)) {
    return 'android';
  }
  
  return 'web';
}

export function usePaymentMethods(regionId?: string) {
  const [paymentConfig, setPaymentConfig] = useState<RegionPaymentMethods | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const platform = useMemo(() => detectPlatform(), []);

  useEffect(() => {
    if (!regionId) {
      setIsLoading(false);
      return;
    }

    const fetchPaymentMethods = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const { data, error: fetchError } = await supabase
          .from('region_payment_methods')
          .select('*')
          .eq('region_id', regionId)
          .single();

        if (fetchError) {
          // If no config exists, return defaults
          if (fetchError.code === 'PGRST116') {
            setPaymentConfig({
              region_id: regionId,
              cash_enabled: true,
              card_enabled: true,
              wallet_enabled: false,
              apple_pay_enabled: false,
              google_pay_enabled: false,
            });
          } else {
            throw fetchError;
          }
        } else {
          setPaymentConfig(data);
        }
      } catch (err) {
        console.error('Error fetching payment methods:', err);
        setError('Failed to load payment methods');
      } finally {
        setIsLoading(false);
      }
    };

    fetchPaymentMethods();
  }, [regionId]);

  // Get available payment methods filtered by platform and enabled status
  const availablePaymentMethods = useMemo((): PaymentMethod[] => {
    if (!paymentConfig) return [];

    return ALL_PAYMENT_METHODS
      .map(method => ({
        ...method,
        enabled: paymentConfig[`${method.id}_enabled` as keyof RegionPaymentMethods] as boolean,
      }))
      .filter(method => {
        // Filter by enabled
        if (!method.enabled) return false;

        // Filter by platform
        if (method.platform === 'ios' && platform !== 'ios' && platform !== 'web') return false;
        if (method.platform === 'android' && platform !== 'android' && platform !== 'web') return false;

        // Hide Apple Pay on Android, hide Google Pay on iOS
        if (method.id === 'apple_pay' && platform === 'android') return false;
        if (method.id === 'google_pay' && platform === 'ios') return false;

        return true;
      });
  }, [paymentConfig, platform]);

  return {
    paymentConfig,
    availablePaymentMethods,
    allPaymentMethods: ALL_PAYMENT_METHODS,
    isLoading,
    error,
    platform,
  };
}

export function usePaymentMethodsAdmin(regionId?: string) {
  const [paymentConfig, setPaymentConfig] = useState<RegionPaymentMethods | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!regionId) {
      setIsLoading(false);
      return;
    }

    const fetchPaymentMethods = async () => {
      try {
        setIsLoading(true);

        const { data, error } = await supabase
          .from('region_payment_methods')
          .select('*')
          .eq('region_id', regionId)
          .single();

        if (error && error.code !== 'PGRST116') {
          throw error;
        }

        if (data) {
          setPaymentConfig(data);
        } else {
          // Create default config
          setPaymentConfig({
            region_id: regionId,
            cash_enabled: true,
            card_enabled: true,
            wallet_enabled: false,
            apple_pay_enabled: false,
            google_pay_enabled: false,
          });
        }
      } catch (err) {
        console.error('Error fetching payment methods:', err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchPaymentMethods();
  }, [regionId]);

  const updatePaymentMethod = async (method: PaymentMethodType, enabled: boolean) => {
    if (!regionId || !paymentConfig) return;

    const updatedConfig = {
      ...paymentConfig,
      [`${method}_enabled`]: enabled,
    };

    setPaymentConfig(updatedConfig);
    setIsSaving(true);

    try {
      const { error } = await supabase
        .from('region_payment_methods')
        .upsert({
          region_id: regionId,
          cash_enabled: updatedConfig.cash_enabled,
          card_enabled: updatedConfig.card_enabled,
          wallet_enabled: updatedConfig.wallet_enabled,
          apple_pay_enabled: updatedConfig.apple_pay_enabled,
          google_pay_enabled: updatedConfig.google_pay_enabled,
        }, {
          onConflict: 'region_id',
        });

      if (error) throw error;
    } catch (err) {
      console.error('Error updating payment method:', err);
      // Revert on error
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
