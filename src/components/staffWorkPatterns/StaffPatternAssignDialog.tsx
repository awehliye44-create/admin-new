import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2 } from 'lucide-react';
import { ROLE_LABELS, StaffRole } from '@/hooks/useStaffProfile';
import { StaffWorkPatternRow } from '@/lib/staffWorkPatternsModel';

export interface AssignableStaffMember {
  id: string;
  full_name: string;
  staff_role_id: string;
  role: StaffRole;
  is_active: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pattern: StaffWorkPatternRow | null;
  staffMembers: AssignableStaffMember[];
  assignedStaffIds: string[];
  onSubmit: (staffIds: string[]) => Promise<void>;
}

export function StaffPatternAssignDialog({
  open,
  onOpenChange,
  pattern,
  staffMembers,
  assignedStaffIds,
  onSubmit,
}: Props) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setSelectedIds(assignedStaffIds);
    }
  }, [open, assignedStaffIds]);

  const toggleStaff = (staffId: string, checked: boolean) => {
    setSelectedIds((current) =>
      checked ? [...new Set([...current, staffId])] : current.filter((id) => id !== staffId),
    );
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      await onSubmit(selectedIds);
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  const activeStaff = staffMembers.filter((member) => member.is_active);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Assign staff to pattern</DialogTitle>
          <DialogDescription>
            {pattern
              ? `Select internal staff for "${pattern.name}". Only assigned patterns count toward coverage.`
              : 'Select internal staff members.'}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="h-72 pr-4">
          <div className="space-y-3">
            {activeStaff.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active internal staff found.</p>
            ) : (
              activeStaff.map((member) => (
                <label
                  key={member.id}
                  className="flex items-start gap-3 rounded-lg border p-3 cursor-pointer"
                >
                  <Checkbox
                    checked={selectedIds.includes(member.id)}
                    onCheckedChange={(checked) => toggleStaff(member.id, checked === true)}
                  />
                  <div>
                    <p className="font-medium">{member.full_name}</p>
                    <p className="text-sm text-muted-foreground">
                      {member.staff_role_id} · {ROLE_LABELS[member.role]}
                    </p>
                  </div>
                </label>
              ))
            )}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save assignments
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
