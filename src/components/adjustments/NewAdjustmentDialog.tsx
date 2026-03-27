import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Search } from 'lucide-react';
import { getCurrencySymbol } from '@/lib/regionSettings';

const ENTRY_TYPES = [
  { value: 'ADJUSTMENT', label: 'Adjustment', description: 'General credit or debit' },
  { value: 'BONUS', label: 'Bonus', description: 'Incentive or reward payment' },
  { value: 'REFUND_DEBIT', label: 'Refund Debit', description: 'Deduct for rider refund' },
  { value: 'CASHOUT_FEE', label: 'Cashout Fee', description: 'Early cashout fee' },
];

interface NewAdjustmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NewAdjustmentDialog({ open, onOpenChange }: NewAdjustmentDialogProps) {
  const queryClient = useQueryClient();
  const [driverSearch, setDriverSearch] = useState('');
  const [selectedDriverId, setSelectedDriverId] = useState('');
  const [selectedDriverName, setSelectedDriverName] = useState('');
  const [entryType, setEntryType] = useState('ADJUSTMENT');
  const [amount, setAmount] = useState('');
  const [isCredit, setIsCredit] = useState(true);
  const [reason, setReason] = useState('');
  const [tripId, setTripId] = useState('');

  const { data: drivers = [] } = useQuery({
    queryKey: ['adjustment-drivers-search', driverSearch],
    queryFn: async () => {
      if (driverSearch.length < 2) return [];
      const { data, error } = await supabase
        .from('drivers')
        .select('id, first_name, last_name, driver_code')
        .or(`first_name.ilike.%${driverSearch}%,last_name.ilike.%${driverSearch}%,driver_code.ilike.%${driverSearch}%`)
        .limit(10);
      if (error) throw error;
      return data || [];
    },
    enabled: driverSearch.length >= 2 && !selectedDriverId,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const amountPence = Math.round(parseFloat(amount) * 100);
      const finalAmount = isCredit ? amountPence : -amountPence;

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const response = await supabase.functions.invoke('admin-driver-adjustment', {
        body: {
          driver_id: selectedDriverId,
          amount_pence: finalAmount,
          entry_type: entryType,
          reason,
          trip_id: tripId || undefined,
        },
      });

      if (response.error) throw response.error;
      if (response.data?.error) throw new Error(response.data.error);
      return response.data;
    },
    onSuccess: (data) => {
      const amountFormatted = `£${Math.abs(data.ledgerEntry.amount / 100).toFixed(2)}`;
      toast.success(`${isCredit ? 'Credit' : 'Debit'} of ${amountFormatted} applied to ${selectedDriverName}`);
      queryClient.invalidateQueries({ queryKey: ['adjustments-ledger'] });
      resetForm();
      onOpenChange(false);
    },
    onError: (error: Error) => {
      toast.error(`Failed: ${error.message}`);
    },
  });

  const resetForm = () => {
    setDriverSearch('');
    setSelectedDriverId('');
    setSelectedDriverName('');
    setEntryType('ADJUSTMENT');
    setAmount('');
    setIsCredit(true);
    setReason('');
    setTripId('');
  };

  const selectDriver = (id: string, name: string) => {
    setSelectedDriverId(id);
    setSelectedDriverName(name);
    setDriverSearch(name);
  };

  const canSubmit = selectedDriverId && amount && parseFloat(amount) > 0 && reason;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetForm(); onOpenChange(v); }}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>New Financial Adjustment</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Driver search */}
          <div className="space-y-2">
            <Label>Driver</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name or driver code..."
                className="pl-9"
                value={driverSearch}
                onChange={(e) => {
                  setDriverSearch(e.target.value);
                  if (selectedDriverId) {
                    setSelectedDriverId('');
                    setSelectedDriverName('');
                  }
                }}
              />
            </div>
            {drivers.length > 0 && !selectedDriverId && (
              <div className="border rounded-md max-h-40 overflow-y-auto">
                {drivers.map((d) => (
                  <button
                    key={d.id}
                    className="w-full text-left px-3 py-2 hover:bg-muted text-sm flex justify-between"
                    onClick={() => selectDriver(d.id, `${d.first_name} ${d.last_name}`)}
                  >
                    <span className="font-medium">{d.first_name} {d.last_name}</span>
                    <span className="text-muted-foreground font-mono">{d.driver_code}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Type */}
          <div className="space-y-2">
            <Label>Adjustment Type</Label>
            <Select value={entryType} onValueChange={setEntryType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ENTRY_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    <div>
                      <span>{t.label}</span>
                      <span className="text-xs text-muted-foreground ml-2">— {t.description}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Direction + Amount */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Direction</Label>
              <Select value={isCredit ? 'credit' : 'debit'} onValueChange={(v) => setIsCredit(v === 'credit')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="credit">Credit (+)</SelectItem>
                  <SelectItem value="debit">Debit (−)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Amount (£)</Label>
              <Input
                type="number"
                step="0.01"
                min="0.01"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>

          {/* Reason */}
          <div className="space-y-2">
            <Label>Reason <span className="text-destructive">*</span></Label>
            <Textarea
              placeholder="Describe the reason for this adjustment..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
          </div>

          {/* Trip ID (optional) */}
          <div className="space-y-2">
            <Label>Trip ID <span className="text-xs text-muted-foreground">(optional)</span></Label>
            <Input
              placeholder="Link to a specific trip..."
              value={tripId}
              onChange={(e) => setTripId(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { resetForm(); onOpenChange(false); }}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!canSubmit || mutation.isPending}
          >
            {mutation.isPending ? 'Applying...' : `Apply ${isCredit ? 'Credit' : 'Debit'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
