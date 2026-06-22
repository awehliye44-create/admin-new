import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, Ticket } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';

export interface PersonalVoucherRider {
  id: string;
  customer_code: string;
  first_name: string | null;
  last_name: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rider: PersonalVoucherRider | null;
}

const EMPTY_FORM = {
  code: '',
  discount_type: 'fixed' as 'fixed' | 'percent',
  discount_value: '',
  min_fare: '0',
  max_uses: '1',
  expires_at: '',
  is_active: true,
  notes: '',
};

function riderDisplayName(rider: PersonalVoucherRider) {
  const name = `${rider.first_name || ''} ${rider.last_name || ''}`.trim();
  return name || 'Unknown';
}

function generateVoucherCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = 'PV-';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export function PersonalVoucherDialog({ open, onOpenChange, rider }: Props) {
  const { user } = useAuth();
  const [form, setForm] = useState(EMPTY_FORM);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm({
      ...EMPTY_FORM,
      code: generateVoucherCode(),
    });
  }, [open, rider?.id]);

  const handleCreate = async () => {
    if (!rider) return;
    if (!form.code.trim()) {
      toast.error('Please enter a voucher code');
      return;
    }
    const discountValue = parseFloat(form.discount_value);
    if (!Number.isFinite(discountValue) || discountValue <= 0) {
      toast.error('Please enter a valid discount value');
      return;
    }
    if (form.discount_type === 'percent' && discountValue > 100) {
      toast.error('Percentage discount cannot exceed 100%');
      return;
    }
    const maxUses = parseInt(form.max_uses, 10);
    if (!Number.isFinite(maxUses) || maxUses < 1) {
      toast.error('Maximum uses must be at least 1');
      return;
    }

    setIsSaving(true);
    try {
      const payload = {
        customer_id: rider.id,
        code: form.code.toUpperCase().trim(),
        discount_type: form.discount_type,
        discount_value: discountValue,
        min_fare: form.min_fare ? parseFloat(form.min_fare) : 0,
        max_uses: maxUses,
        expires_at: form.expires_at ? new Date(form.expires_at).toISOString() : null,
        is_active: form.is_active,
        notes: form.notes.trim() || null,
        created_by: user?.id ?? null,
      };

      const { error } = await (supabase as any).from('customer_personal_vouchers').insert([payload]);
      if (error) throw error;

      toast.success(`Personal voucher created for ${riderDisplayName(rider)}`);
      onOpenChange(false);
    } catch (err: unknown) {
      console.error('Error creating personal voucher:', err);
      const message = err instanceof Error ? err.message : 'Failed to create voucher';
      if (message.includes('duplicate') || message.includes('unique')) {
        toast.error('This voucher code already exists');
      } else {
        toast.error(message);
      }
    } finally {
      setIsSaving(false);
    }
  };

  if (!rider) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ticket className="h-5 w-5 text-primary" />
            Create Personal Voucher
          </DialogTitle>
          <DialogDescription>
            This voucher will be locked to the selected rider only.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label>Customer Name</Label>
            <Input value={riderDisplayName(rider)} readOnly className="bg-muted" />
          </div>
          <div className="grid gap-2">
            <Label>Customer ID</Label>
            <Input value={rider.customer_code} readOnly className="bg-muted font-mono" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="voucher-code">Voucher Code</Label>
            <div className="flex gap-2">
              <Input
                id="voucher-code"
                value={form.code}
                onChange={(e) => setForm((prev) => ({ ...prev, code: e.target.value.toUpperCase() }))}
                placeholder="PV-ABCD1234"
                className="font-mono"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => setForm((prev) => ({ ...prev, code: generateVoucherCode() }))}
              >
                Generate
              </Button>
            </div>
          </div>
          <div className="grid gap-2">
            <Label>Discount Type</Label>
            <Select
              value={form.discount_type}
              onValueChange={(value: 'fixed' | 'percent') =>
                setForm((prev) => ({ ...prev, discount_type: value }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fixed">Fixed Amount (£)</SelectItem>
                <SelectItem value="percent">Percentage (%)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="discount-value">Discount Value</Label>
            <Input
              id="discount-value"
              type="number"
              min="0"
              step="0.01"
              value={form.discount_value}
              onChange={(e) => setForm((prev) => ({ ...prev, discount_value: e.target.value }))}
              placeholder={form.discount_type === 'fixed' ? '5.00' : '10'}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="min-fare">Minimum Fare (£)</Label>
              <Input
                id="min-fare"
                type="number"
                min="0"
                step="0.01"
                value={form.min_fare}
                onChange={(e) => setForm((prev) => ({ ...prev, min_fare: e.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="max-uses">Maximum Uses</Label>
              <Input
                id="max-uses"
                type="number"
                min="1"
                step="1"
                value={form.max_uses}
                onChange={(e) => setForm((prev) => ({ ...prev, max_uses: e.target.value }))}
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="expires-at">Expiry Date</Label>
            <Input
              id="expires-at"
              type="datetime-local"
              value={form.expires_at}
              onChange={(e) => setForm((prev) => ({ ...prev, expires_at: e.target.value }))}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label htmlFor="voucher-active">Active</Label>
              <p className="text-xs text-muted-foreground">Inactive vouchers cannot be redeemed</p>
            </div>
            <Switch
              id="voucher-active"
              checked={form.is_active}
              onCheckedChange={(checked) => setForm((prev) => ({ ...prev, is_active: checked }))}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="voucher-notes">Notes</Label>
            <Textarea
              id="voucher-notes"
              value={form.notes}
              onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
              rows={3}
              placeholder="Internal notes (optional)"
            />
          </div>
          {form.expires_at && (
            <p className="text-xs text-muted-foreground">
              Expires {format(new Date(form.expires_at), 'PPpp')}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={isSaving}>
            {isSaving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Create Voucher
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
