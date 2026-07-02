import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { AlertTriangle, ShieldCheck, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

type EraRow = { setting_value: unknown } | null;

type PreviewResult = {
  preview: true;
  current_era: string;
  payout_items_to_void: number;
  payout_batches_to_archive: number;
  authorizations_to_cancel: number;
  early_cashouts_to_cancel: number;
  settlements_to_mark: number;
};

type RunResult = {
  ok: true;
  result: {
    started_at: string;
    drivers_reset: number;
    ledger_rows_inserted: number;
    payout_items_voided: number;
    payout_batches_archived: number;
    payout_authorizations_cancelled: number;
    early_cashouts_cancelled: number;
    settlements_marked_ineligible: number;
  };
};

export function DigitalFinanceEraPanel() {
  const [era, setEra] = useState<'digital' | 'legacy_cash' | 'unknown'>('unknown');
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult['result'] | null>(null);

  useEffect(() => {
    (async () => {
      const [{ data: u }, eraRes, startedRes] = await Promise.all([
        supabase.auth.getUser(),
        supabase.from('admin_settings').select('setting_value').eq('setting_key', 'finance_era').maybeSingle(),
        supabase.from('admin_settings').select('setting_value').eq('setting_key', 'finance_era_started_at').maybeSingle(),
      ]);
      const uid = u.user?.id;
      if (uid) {
        const { data: role } = await supabase
          .from('user_roles').select('role').eq('user_id', uid).eq('role', 'super_admin' as any).maybeSingle();
        setIsSuperAdmin(!!role);
      }
      const eraVal = (eraRes.data as EraRow)?.setting_value;
      const eraStr = typeof eraVal === 'string' ? eraVal : (eraVal ? String(eraVal) : 'legacy_cash');
      setEra(eraStr === 'digital' ? 'digital' : 'legacy_cash');
      const startedVal = (startedRes.data as EraRow)?.setting_value;
      setStartedAt(typeof startedVal === 'string' ? startedVal : null);
    })();
  }, []);

  const runPreview = async () => {
    setPreviewing(true);
    try {
      const { data, error } = await supabase.functions.invoke('admin-digital-finance-migration', {
        body: {}, method: 'POST',
        headers: {},
      });
      if (error) throw error;
      // preview via query param not available through invoke; use direct fetch
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-digital-finance-migration?preview=1`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Preview failed');
      setPreview(json);
      void data;
    } catch (e) {
      toast.error(`Preview failed: ${(e as Error).message}`);
    } finally {
      setPreviewing(false);
    }
  };

  const runMigration = async () => {
    setRunning(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-digital-finance-migration`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Migration failed');
      setResult(json.result);
      setEra('digital');
      setStartedAt(json.result.started_at);
      setConfirmOpen(false);
      toast.success('Digital Finance Migration completed');
    } catch (e) {
      toast.error(`Migration failed: ${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Finance Era</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Operational state for driver wallets, payouts and settlements.
          </p>
        </div>
        <Badge variant={era === 'digital' ? 'default' : 'secondary'} className="gap-1">
          {era === 'digital' ? <ShieldCheck className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
          {era === 'digital' ? 'Digital Finance Era (Active)' : 'Legacy Cash Era'}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {era === 'digital' && startedAt && (
          <Alert>
            <ShieldCheck className="h-4 w-4" />
            <AlertTitle>Digital era active</AlertTitle>
            <AlertDescription>
              Started {new Date(startedAt).toLocaleString()}. All new trips settle card-only. Historical
              cash-era ledger entries remain available for audit.
            </AlertDescription>
          </Alert>
        )}

        {era !== 'digital' && (
          <>
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>One-time operational reset available</AlertTitle>
              <AlertDescription>
                Zero every driver wallet via an audit-safe MIGRATION_RESET ledger entry, void
                orphaned pending payouts, archive open batches, and switch the platform to Digital
                Finance Era. Stripe balances are not touched. Historical data is preserved.
              </AlertDescription>
            </Alert>

            {preview && (
              <div className="rounded-md border p-3 text-sm space-y-1 bg-muted/30">
                <div className="font-medium">Preview impact</div>
                <div>Payout items to void: <b>{preview.payout_items_to_void}</b></div>
                <div>Payout batches to archive: <b>{preview.payout_batches_to_archive}</b></div>
                <div>Authorizations to cancel: <b>{preview.authorizations_to_cancel}</b></div>
                <div>Early cashouts to cancel: <b>{preview.early_cashouts_to_cancel}</b></div>
                <div>Settlements to mark ineligible: <b>{preview.settlements_to_mark}</b></div>
              </div>
            )}

            <div className="flex gap-2">
              <Button variant="outline" onClick={runPreview} disabled={previewing || !isSuperAdmin}>
                {previewing && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                Preview impact
              </Button>
              <Button
                variant="destructive"
                onClick={() => setConfirmOpen(true)}
                disabled={!isSuperAdmin}
              >
                Run Digital Finance Migration
              </Button>
            </div>
            {!isSuperAdmin && (
              <p className="text-xs text-muted-foreground">Only super_admin can run this migration.</p>
            )}
          </>
        )}

        {result && (
          <div className="rounded-md border p-3 text-sm space-y-1 bg-muted/30">
            <div className="font-medium">Migration result</div>
            <div>Drivers reset: <b>{result.drivers_reset}</b></div>
            <div>Ledger rows inserted: <b>{result.ledger_rows_inserted}</b></div>
            <div>Payout items voided: <b>{result.payout_items_voided}</b></div>
            <div>Payout batches archived: <b>{result.payout_batches_archived}</b></div>
            <div>Authorizations cancelled: <b>{result.payout_authorizations_cancelled}</b></div>
            <div>Early cashouts cancelled: <b>{result.early_cashouts_cancelled}</b></div>
            <div>Settlements marked ineligible: <b>{result.settlements_marked_ineligible}</b></div>
          </div>
        )}
      </CardContent>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Digital Finance Migration</DialogTitle>
            <DialogDescription>
              This is a one-time irreversible operational reset. Every driver wallet balance,
              recovery debt, and scheduled payout will be zeroed via an auditable ledger entry.
              Historical data is preserved. Stripe balances are not touched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={running}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={runMigration} disabled={running}>
              {running && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Run migration
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
