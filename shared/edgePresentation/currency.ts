/** Admin presentation-only helpers; not part of Edge uploads. */
import { getCurrencySymbol } from "../../supabase/functions/_shared/currency.ts";


export function formatCurrency(amount: number, currencyCode: string): string {
  return `${getCurrencySymbol(currencyCode)}${amount.toFixed(2)}`;
}
