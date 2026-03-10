import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface LedgerEntry {
  id: string;
  driver_id: string;
  trip_id: string | null;
  entry_type: 'CASH_COMMISSION_DEBT' | 'TRIP_EARNING_NET' | 'PAYOUT' | 'EARLY_CASHOUT' | 'CASHOUT_FEE' | 'ADJUSTMENT' | 'BONUS' | 'DEBT_RECOVERY' | 'REFUND_DEBIT';
  amount_pence: number;
  currency_code: string;
  description: string | null;
  reference_id: string | null;
  created_at: string;
}

export interface WalletBalance {
  available_pence: number;
  total_debt_pence: number;
  total_earnings_pence: number;
  can_payout: boolean;
  can_early_cashout: boolean;
}

export interface DriverWalletData {
  driver_id: string;
  first_name: string;
  last_name: string;
  email: string;
  available_pence: number;
  total_debt_pence: number;
  total_earnings_pence: number;
  trip_count: number;
}

// Format pence to currency string
export function formatPence(pence: number, currencyCode: string = 'GBP'): string {
  const amount = pence / 100;
  const symbol = currencyCode === 'GBP' ? '£' : 
                 currencyCode === 'USD' ? '$' : 
                 currencyCode === 'EUR' ? '€' : currencyCode;
  
  const formatted = Math.abs(amount).toFixed(2);
  return pence < 0 ? `-${symbol}${formatted}` : `${symbol}${formatted}`;
}

// Get entry type display name and color
export function getEntryTypeDisplay(entryType: LedgerEntry['entry_type']): { label: string; color: string } {
  switch (entryType) {
    case 'CASH_COMMISSION_DEBT':
      return { label: 'Cash Commission', color: 'text-red-500' };
    case 'TRIP_EARNING_NET':
      return { label: 'Trip Earnings', color: 'text-green-500' };
    case 'PAYOUT':
      return { label: 'Payout', color: 'text-blue-500' };
    case 'EARLY_CASHOUT':
      return { label: 'Early Cashout', color: 'text-blue-500' };
    case 'CASHOUT_FEE':
      return { label: 'Cashout Fee', color: 'text-orange-500' };
    case 'ADJUSTMENT':
      return { label: 'Adjustment', color: 'text-purple-500' };
    case 'BONUS':
      return { label: 'Bonus', color: 'text-green-600' };
    case 'DEBT_RECOVERY':
      return { label: 'Debt Recovery', color: 'text-orange-600' };
    case 'REFUND_DEBIT':
      return { label: 'Refund Debit', color: 'text-red-600' };
    default:
      return { label: entryType, color: 'text-muted-foreground' };
  }
}

// Hook to fetch all driver wallet balances (admin view)
export function useDriverWallets() {
  return useQuery({
    queryKey: ['driver-wallets'],
    queryFn: async (): Promise<DriverWalletData[]> => {
      // Fetch from the view
      const { data, error } = await supabase
        .from('driver_wallet_balance')
        .select('*');

      if (error) {
        console.error('Error fetching driver wallets:', error);
        throw error;
      }

      return (data || []).map(d => ({
        driver_id: d.driver_id,
        first_name: d.first_name || '',
        last_name: d.last_name || '',
        email: d.email || '',
        available_pence: Number(d.available_pence) || 0,
        total_debt_pence: Number(d.total_debt_pence) || 0,
        total_earnings_pence: Number(d.total_earnings_pence) || 0,
        trip_count: Number(d.trip_count) || 0
      }));
    }
  });
}

// Hook to fetch a single driver's wallet balance
export function useDriverWalletBalance(driverId: string | null) {
  return useQuery({
    queryKey: ['driver-wallet-balance', driverId],
    queryFn: async (): Promise<WalletBalance | null> => {
      if (!driverId) return null;

      const { data, error } = await supabase
        .from('driver_wallet_balance')
        .select('*')
        .eq('driver_id', driverId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          // No data found - return zero balance
          return {
            available_pence: 0,
            total_debt_pence: 0,
            total_earnings_pence: 0,
            can_payout: false,
            can_early_cashout: false
          };
        }
        throw error;
      }

      const available = Number(data.available_pence) || 0;
      return {
        available_pence: available,
        total_debt_pence: Number(data.total_debt_pence) || 0,
        total_earnings_pence: Number(data.total_earnings_pence) || 0,
        can_payout: available > 0,
        can_early_cashout: available > 50 // 50p minimum for fee
      };
    },
    enabled: !!driverId
  });
}

// Hook to fetch a driver's ledger entries
export function useDriverLedger(driverId: string | null, limit: number = 50) {
  return useQuery({
    queryKey: ['driver-ledger', driverId, limit],
    queryFn: async (): Promise<LedgerEntry[]> => {
      if (!driverId) return [];

      const { data, error } = await supabase
        .from('driver_ledger')
        .select('*')
        .eq('driver_id', driverId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        console.error('Error fetching driver ledger:', error);
        throw error;
      }

      return (data || []) as LedgerEntry[];
    },
    enabled: !!driverId
  });
}
