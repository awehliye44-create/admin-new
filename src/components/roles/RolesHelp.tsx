import { ReactNode, useState } from 'react';
import { HelpCircle, Info, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DELEGATION_CONFIRM,
  HELP_MODAL_BODY,
  HELP_MODAL_TITLE,
  HELP_MODAL_WARNING,
} from '../../../shared/rolesPermissionsSSOT';

/** Small inline information tooltip used across the Roles & Permissions page. */
export function HelpTip({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          role="button"
          aria-label={text}
          className="inline-flex items-center gap-1 cursor-help align-middle outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
        >
          {children}
          <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[280px] text-xs leading-relaxed">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

/** "How permissions work" control + modal shown next to the page title. */
export function PermissionsHelpButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="gap-2"
        onClick={() => setOpen(true)}
        data-testid="permissions-help-button"
      >
        <HelpCircle className="h-4 w-4" />
        How permissions work
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{HELP_MODAL_TITLE}</DialogTitle>
            <DialogDescription>
              Staff access is owned by the Super Admin and delegated explicitly.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-sm text-muted-foreground">
            {HELP_MODAL_BODY.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>

          <Alert className="bg-amber-500/10 border-amber-500/30">
            <ShieldAlert className="h-4 w-4 text-amber-500" />
            <AlertDescription className="text-amber-600 dark:text-amber-400 text-sm">
              {HELP_MODAL_WARNING}
            </AlertDescription>
          </Alert>

          <DialogFooter>
            <Button onClick={() => setOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Confirmation shown before delegating a sensitive permission-management capability. */
export function DelegationConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  detail,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: () => void;
  detail?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{DELEGATION_CONFIRM.title}</DialogTitle>
          <DialogDescription>{DELEGATION_CONFIRM.message}</DialogDescription>
        </DialogHeader>
        {detail && <p className="text-sm font-medium">{detail}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {DELEGATION_CONFIRM.cancel}
          </Button>
          <Button onClick={onConfirm}>{DELEGATION_CONFIRM.confirm}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
