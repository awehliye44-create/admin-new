/**
 * @deprecated Use `useFinanceReconciliationRevenue` from Financial Reconciliation SSOT.
 */
export {
  useFinanceReconciliationRevenue as useLedgerRevenue,
  type RevenuePeriod,
  type RevenueDataPoint,
  type ServiceAreaRevenueBreakdown,
  type FinanceReconciliationRevenueResult as LedgerRevenueResult,
} from '@/hooks/useFinanceReconciliationRevenue';
