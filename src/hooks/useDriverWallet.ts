import { useQuery } from '@tanstack/react-query';
import { getCurrencySymbol } from '@/lib/regionSettings';
import { supabase } from '@/integrations/supabase/client';

// Unified financial summary from the driver_financial_summary view
export interface DriverFinancialSummary {
  driver_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  is_online: boolean;
  rating: number | null;
  approval_status: string;
  stripe_account_id: string | null;
  payouts_enabled: boolean;
  onboarding_complete: boolean;
  // Trip totals
  gross_trip_total: number;
  completed_trips: number;
  // Card breakdown
  card_net_credits: number;
  card_gross_total: number;
  card_commission_total: number;
  card_trip_count: number;
  // Cash breakdown
  cash_gross_total: number;
  cash_net_earnings: number;
  cash_commission_debits: number;
  cash_trip_count: number;
  // Commission
  company_commission_total: number;
  // Today
  today_gross_earnings: number;
  today_cash_earnings: number;
  today_card_earnings: number;
  today_trip_count: number;
  // Ledger
  adjustments_total: number;
  total_payouts_sent: number;
  total_fees: number;
  // Wallet
  wallet_balance: number;
  available_for_payout: number;
  amount_owed_to_onecab: number;
}

export interface LedgerEntry {
  id: string;
  driver_id: string;
  trip_id: string | null;
  entry_type: string;
  amount_pence: number;
  currency_code: string;
  description: string | null;
  reference_id: string | null;
  created_at: string;
}

// Format pence to currency string
export function formatPence(pence: number, currencyCode: string = ''): string {
  const amount = pence / 100;
  const symbol = getCurrencySymbol(currencyCode);
  const formatted = Math.abs(amount).toFixed(2);
  return pence < 0 ? `-${symbol}${formatted}` : `${symbol}${formatted}`;
}

// Get entry type display name and color
export function getEntryTypeDisplay(entryType: string): { label: string; color: string } {
  switch (entryType) {
    case 'CASH_COMMISSION_DEBT':
      return { label: 'Cash Commission Debit', color: 'text-red-500' };
    case 'TRIP_EARNING_NET':
      return { label: 'Card Trip Credit', color: 'text-green-500' };
    case 'PAYOUT':
    case 'WEEKLY_PAYOUT':
    case 'MANUAL_PAYOUT':
      return { label: 'Payout', color: 'text-blue-500' };
    case 'EARLY_CASHOUT':
      return { label: 'Early Cashout', color: 'text-blue-500' };
    case 'CASHOUT_FEE':
      return { label: 'Cashout Fee', color: 'text-orange-500' };
    case 'ADJUSTMENT':
      return { label: 'Manual Adjustment', color: 'text-purple-500' };
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

// Hook to fetch all driver financial summaries (admin view)
export function useDriverFinancialSummaries() {
  return useQuery({
    queryKey: ['driver-financial-summaries'],
    queryFn: async (): Promise<DriverFinancialSummary[]> => {
      const { data, error } = await supabase
        .from('driver_financial_summary')
        .select('*');

      if (error) {
        console.error('Error fetching driver financial summaries:', error);
        throw error;
      }

      return (data || []).map(d => ({
        driver_id: d.driver_id,
        first_name: d.first_name || '',
        last_name: d.last_name || '',
        email: d.email || '',
        phone: d.phone,
        is_online: d.is_online || false,
        rating: d.rating,
        approval_status: d.approval_status || 'pending',
        stripe_account_id: d.stripe_account_id,
        payouts_enabled: d.payouts_enabled || false,
        onboarding_complete: d.onboarding_complete || false,
        gross_trip_total: Number(d.gross_trip_total) || 0,
        completed_trips: Number(d.completed_trips) || 0,
        card_net_credits: Number(d.card_net_credits) || 0,
        card_gross_total: Number(d.card_gross_total) || 0,
        card_commission_total: Number(d.card_commission_total) || 0,
        card_trip_count: Number(d.card_trip_count) || 0,
        cash_gross_total: Number(d.cash_gross_total) || 0,
        cash_net_earnings: Number(d.cash_net_earnings) || 0,
        cash_commission_debits: Number(d.cash_commission_debits) || 0,
        cash_trip_count: Number(d.cash_trip_count) || 0,
        company_commission_total: Number(d.company_commission_total) || 0,
        today_gross_earnings: Number(d.today_gross_earnings) || 0,
        today_cash_earnings: Number(d.today_cash_earnings) || 0,
        today_card_earnings: Number(d.today_card_earnings) || 0,
        today_trip_count: Number(d.today_trip_count) || 0,
        adjustments_total: Number(d.adjustments_total) || 0,
        total_payouts_sent: Number(d.total_payouts_sent) || 0,
        total_fees: Number(d.total_fees) || 0,
        wallet_balance: Number(d.wallet_balance) || 0,
        available_for_payout: Number(d.available_for_payout) || 0,
        amount_owed_to_onecab: Number(d.amount_owed_to_onecab) || 0,
      }));
    }
  });
}

// Hook to fetch a single driver's financial summary
export function useDriverFinancialSummary(driverId: string | null) {
  return useQuery({
    queryKey: ['driver-financial-summary', driverId],
    queryFn: async (): Promise<DriverFinancialSummary | null> => {
      if (!driverId) return null;

      const { data, error } = await supabase
        .from('driver_financial_summary')
        .select('*')
        .eq('driver_id', driverId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
      }

      return {
        driver_id: data.driver_id,
        first_name: data.first_name || '',
        last_name: data.last_name || '',
        email: data.email || '',
        phone: data.phone,
        is_online: data.is_online || false,
        rating: data.rating,
        approval_status: data.approval_status || 'pending',
        stripe_account_id: data.stripe_account_id,
        payouts_enabled: data.payouts_enabled || false,
        onboarding_complete: data.onboarding_complete || false,
        gross_trip_total: Number(data.gross_trip_total) || 0,
        completed_trips: Number(data.completed_trips) || 0,
        card_net_credits: Number(data.card_net_credits) || 0,
        card_gross_total: Number(data.card_gross_total) || 0,
        card_commission_total: Number(data.card_commission_total) || 0,
        card_trip_count: Number(data.card_trip_count) || 0,
        cash_gross_total: Number(data.cash_gross_total) || 0,
        cash_net_earnings: Number(data.cash_net_earnings) || 0,
        cash_commission_debits: Number(data.cash_commission_debits) || 0,
        cash_trip_count: Number(data.cash_trip_count) || 0,
        company_commission_total: Number(data.company_commission_total) || 0,
        today_gross_earnings: Number(data.today_gross_earnings) || 0,
        today_cash_earnings: Number(data.today_cash_earnings) || 0,
        today_card_earnings: Number(data.today_card_earnings) || 0,
        today_trip_count: Number(data.today_trip_count) || 0,
        adjustments_total: Number(data.adjustments_total) || 0,
        total_payouts_sent: Number(data.total_payouts_sent) || 0,
        total_fees: Number(data.total_fees) || 0,
        wallet_balance: Number(data.wallet_balance) || 0,
        available_for_payout: Number(data.available_for_payout) || 0,
        amount_owed_to_onecab: Number(data.amount_owed_to_onecab) || 0,
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