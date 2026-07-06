import React from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { AlertTriangle } from 'lucide-react';

type FinancePanelErrorBoundaryProps = {
  panelName: string;
  children: React.ReactNode;
};

type FinancePanelErrorBoundaryState = {
  error: Error | null;
};

/** Isolates a single Financial Reconciliation tab widget from crashing the whole page. */
export class FinancePanelErrorBoundary extends React.Component<
  FinancePanelErrorBoundaryProps,
  FinancePanelErrorBoundaryState
> {
  state: FinancePanelErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): FinancePanelErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`[FinancialReconciliation:${this.props.panelName}]`, error, info);
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{this.props.panelName} failed to load</AlertTitle>
          <AlertDescription className="space-y-3">
            <p className="text-sm">{this.state.error.message || 'An unexpected error occurred.'}</p>
            <Button type="button" variant="outline" size="sm" onClick={this.handleRetry}>
              Retry panel
            </Button>
          </AlertDescription>
        </Alert>
      );
    }
    return this.props.children;
  }
}
