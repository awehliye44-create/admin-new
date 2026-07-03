import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

type TripFinanceNoteDialogProps = {
  tripId: string;
  tripCode?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
};

export function TripFinanceNoteDialog({
  tripId,
  tripCode,
  open,
  onOpenChange,
  onSaved,
}: TripFinanceNoteDialogProps) {
  const [reason, setReason] = useState('');
  const [investigationRequired, setInvestigationRequired] = useState(false);
  const [adjustmentRequest, setAdjustmentRequest] = useState(false);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('admin-add-trip-finance-note', {
        body: {
          trip_id: tripId,
          reason: reason.trim(),
          investigation_required: investigationRequired,
          adjustment_request: adjustmentRequest,
        },
      });
      if (error) throw new Error(data?.error || error.message);
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      toast.success('Finance note saved');
      setReason('');
      setInvestigationRequired(false);
      setAdjustmentRequest(false);
      onOpenChange(false);
      onSaved?.();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add finance note</DialogTitle>
          <DialogDescription>
            {tripCode ?? tripId.slice(0, 8)} — audit-only note. Does not change fare, commission, or Stripe amounts.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Note / reason (required, min 5 chars)</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              placeholder="Describe investigation context or adjustment request…"
            />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="investigation"
              checked={investigationRequired}
              onCheckedChange={(v) => setInvestigationRequired(v === true)}
            />
            <Label htmlFor="investigation" className="font-normal">Mark investigation required</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="adjustment"
              checked={adjustmentRequest}
              onCheckedChange={(v) => setAdjustmentRequest(v === true)}
            />
            <Label htmlFor="adjustment" className="font-normal">Adjustment request (no silent money change)</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saveMutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || reason.trim().length < 5}
          >
            Save note
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
