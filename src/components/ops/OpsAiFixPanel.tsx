import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Wrench, Loader2, CheckCircle, XCircle, ShieldAlert, Zap, AlertTriangle, Info } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useStaffProfile } from '@/hooks/useStaffProfile';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface AiFixProposal {
  explanation: string;
  root_cause: string;
  function_name: string;
  param_value?: string;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
  affected_entities: Array<{ type: string; id: string; description?: string }>;
  estimated_impact: string;
}

interface OpsAiFixPanelProps {
  alertId: string;
  alertStatus: string;
}

const RISK_CONFIG = {
  LOW: { color: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30', icon: Info, label: 'Low Risk' },
  MEDIUM: { color: 'bg-amber-500/10 text-amber-600 border-amber-500/30', icon: AlertTriangle, label: 'Medium Risk' },
  HIGH: { color: 'bg-destructive/10 text-destructive border-destructive/30', icon: ShieldAlert, label: 'High Risk' },
};

export function OpsAiFixPanel({ alertId, alertStatus }: OpsAiFixPanelProps) {
  const { user } = useAuth();
  const { canManageRoles } = useStaffProfile();
  const [analyzing, setAnalyzing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [proposal, setProposal] = useState<AiFixProposal | null>(null);
  const [executionResult, setExecutionResult] = useState<{ success: boolean; result: any; audit_id?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAnalyze = async () => {
    setAnalyzing(true);
    setError(null);
    setProposal(null);
    setExecutionResult(null);

    try {
      const { data, error: fnErr } = await supabase.functions.invoke('ops-ai-fix', {
        body: { action: 'analyze', alert_id: alertId },
      });

      if (fnErr) throw fnErr;
      if (data?.fallback || data?.error) {
        const msg = data?.error || 'AI analysis unavailable';
        setError(msg);
        toast.warning('AI analysis unavailable', { description: msg });
        return;
      }

      setProposal(data.proposal);
    } catch (e: any) {
      setError(e.message || 'Failed to analyze alert');
      toast.error('AI analysis failed', { description: e.message });
    } finally {
      setAnalyzing(false);
    }
  };

  const handleExecute = async () => {
    if (!proposal || proposal.function_name === 'none' || !user) return;

    setExecuting(true);
    setError(null);

    try {
      const { data, error: fnErr } = await supabase.functions.invoke('ops-ai-fix', {
        body: {
          action: 'execute',
          alert_id: alertId,
          user_id: user.id,
          function_name: proposal.function_name,
          param_value: proposal.param_value,
          explanation: proposal.explanation,
          risk_level: proposal.risk_level,
          preview_data: { affected_entities: proposal.affected_entities, estimated_impact: proposal.estimated_impact },
        },
      });

      if (fnErr) throw fnErr;
      if (data?.fallback || (data?.error && !data?.success)) {
        const msg = data?.error || 'Fix execution unavailable';
        setError(msg);
        toast.warning('Fix execution unavailable', { description: msg });
        return;
      }

      setExecutionResult(data);
      if (data.success) {
        toast.success('Fix executed successfully', { description: `Audit ID: ${data.audit_id}` });
      } else {
        toast.error('Fix failed', { description: JSON.stringify(data.result) });
      }
    } catch (e: any) {
      setError(e.message || 'Execution failed');
      toast.error('Fix execution failed', { description: e.message });
    } finally {
      setExecuting(false);
    }
  };

  const riskConfig = proposal ? RISK_CONFIG[proposal.risk_level] : null;
  const RiskIcon = riskConfig?.icon || Info;
  const isFixable = proposal && proposal.function_name !== 'none' && proposal.param_value;
  const isResolved = alertStatus === 'resolved';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Wrench className="h-4 w-4 text-primary" /> AI Fix Advisor
          </CardTitle>
          {!proposal && !executionResult && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleAnalyze}
              disabled={analyzing || isResolved}
            >
              {analyzing ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Zap className="h-4 w-4 mr-1" />
              )}
              {analyzing ? 'Analyzing…' : 'Analyze & Propose Fix'}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {/* Error State */}
        {error && (
          <div className="flex items-center gap-2 text-sm text-destructive mb-4">
            <XCircle className="h-4 w-4" />
            <span>{error}</span>
            <button onClick={handleAnalyze} className="underline ml-2">Retry</button>
          </div>
        )}

        {/* Loading */}
        {analyzing && (
          <div className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-5/6" />
            <p className="text-xs text-muted-foreground mt-2">AI is analyzing the alert and proposing a safe fix…</p>
          </div>
        )}

        {/* No proposal yet */}
        {!analyzing && !proposal && !executionResult && !error && (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <Wrench className="h-8 w-8 text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">No fix analysis yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Click "Analyze & Propose Fix" to have AI suggest a safe repair action
            </p>
          </div>
        )}

        {/* Proposal */}
        {proposal && !executionResult && (
          <div className="space-y-4">
            {/* Risk Badge */}
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={cn('gap-1', riskConfig?.color)}>
                <RiskIcon className="h-3 w-3" />
                {riskConfig?.label}
              </Badge>
              <Badge variant="secondary" className="text-[10px] font-mono">
                {proposal.function_name === 'none' ? 'No fix available' : proposal.function_name}
              </Badge>
            </div>

            {/* Explanation */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Issue & Explanation</p>
              <p className="text-sm leading-relaxed">{proposal.explanation}</p>
            </div>

            {/* Root Cause */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Root Cause</p>
              <p className="text-sm leading-relaxed">{proposal.root_cause}</p>
            </div>

            {/* Preview: Affected Entities */}
            {proposal.affected_entities.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Affected Records</p>
                <div className="space-y-1.5">
                  {proposal.affected_entities.map((entity, i) => (
                    <div key={i} className="flex items-center gap-2 bg-muted/50 rounded-lg px-3 py-2">
                      <Badge variant="outline" className="text-[10px] shrink-0">{entity.type}</Badge>
                      <code className="text-xs font-mono truncate flex-1">{entity.id}</code>
                      {entity.description && (
                        <span className="text-xs text-muted-foreground truncate">{entity.description}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Estimated Impact */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Estimated Impact</p>
              <p className="text-sm leading-relaxed">{proposal.estimated_impact}</p>
            </div>

            {/* Backend function */}
            {isFixable && (
              <div className="bg-muted/50 rounded-lg px-3 py-2">
                <p className="text-xs text-muted-foreground">Backend function to execute:</p>
                <code className="text-xs font-mono text-primary">{proposal.function_name}({proposal.param_value})</code>
              </div>
            )}

            <Separator />

            {/* Action Buttons */}
            <div className="flex gap-2">
              {isFixable ? (
                proposal.risk_level === 'HIGH' ? (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="destructive" size="sm" disabled={executing}>
                        {executing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <ShieldAlert className="h-4 w-4 mr-1" />}
                        Approve & Run Fix (HIGH RISK)
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle className="flex items-center gap-2">
                          <ShieldAlert className="h-5 w-5 text-destructive" /> High Risk Fix Confirmation
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          This action affects payments or payouts and cannot be easily undone.
                          <br /><br />
                          <strong>Function:</strong> {proposal.function_name}<br />
                          <strong>Target:</strong> {proposal.param_value}<br />
                          <strong>Impact:</strong> {proposal.estimated_impact}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={handleExecute} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                          Confirm & Execute
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ) : (
                  <Button variant="default" size="sm" onClick={handleExecute} disabled={executing}>
                    {executing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-1" />}
                    {executing ? 'Executing…' : 'Approve & Run Fix'}
                  </Button>
                )
              ) : (
                <p className="text-sm text-muted-foreground italic">No automated fix available for this alert. Manual intervention required.</p>
              )}
              <Button variant="outline" size="sm" onClick={() => { setProposal(null); setError(null); }}>
                Cancel
              </Button>
              <Button variant="ghost" size="sm" onClick={handleAnalyze} disabled={analyzing}>
                Re-analyze
              </Button>
            </div>
          </div>
        )}

        {/* Execution Result */}
        {executionResult && (
          <div className="space-y-4">
            <div className={cn(
              'flex items-center gap-3 rounded-lg px-4 py-3',
              executionResult.success ? 'bg-emerald-500/10' : 'bg-destructive/10'
            )}>
              {executionResult.success ? (
                <CheckCircle className="h-5 w-5 text-emerald-600" />
              ) : (
                <XCircle className="h-5 w-5 text-destructive" />
              )}
              <div>
                <p className="text-sm font-medium">
                  {executionResult.success ? 'Fix executed successfully' : 'Fix failed'}
                </p>
                {executionResult.audit_id && (
                  <p className="text-xs text-muted-foreground">Audit ID: {executionResult.audit_id}</p>
                )}
              </div>
            </div>

            {/* Result details */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Result</p>
              <pre className="text-xs bg-muted rounded-lg p-3 overflow-auto max-h-40">
                {JSON.stringify(executionResult.result, null, 2)}
              </pre>
            </div>

            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => { setExecutionResult(null); setProposal(null); }}>
                Done
              </Button>
              <Button variant="ghost" size="sm" onClick={handleAnalyze}>
                Analyze Again
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
