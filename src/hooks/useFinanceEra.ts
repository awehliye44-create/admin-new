import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

export type FinanceEra = 'digital' | 'legacy_cash' | 'unknown';

export function useFinanceEra(): {
  era: FinanceEra;
  startedAt: string | null;
  loading: boolean;
  isDigital: boolean;
} {
  const [era, setEra] = useState<FinanceEra>('unknown');
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [eraRes, startedRes] = await Promise.all([
        supabase.from('admin_settings').select('setting_value').eq('setting_key', 'finance_era').maybeSingle(),
        supabase.from('admin_settings').select('setting_value').eq('setting_key', 'finance_era_started_at').maybeSingle(),
      ]);
      if (cancelled) return;
      const eraVal = eraRes.data?.setting_value;
      const eraStr = typeof eraVal === 'string' ? eraVal : eraVal ? String(eraVal) : 'legacy_cash';
      setEra(eraStr === 'digital' ? 'digital' : 'legacy_cash');
      const startedVal = startedRes.data?.setting_value;
      setStartedAt(typeof startedVal === 'string' ? startedVal : null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return { era, startedAt, loading, isDigital: era === 'digital' };
}
