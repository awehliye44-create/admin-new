import { Navigate, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useStaffProfile } from '@/hooks/useStaffProfile';
import { ShieldAlert, Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CRITICAL_BUTTON_MAX_SPINNER_MS } from '@/lib/criticalButtonTimeout';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

/**
 * Auth / admin gate only.
 * Page-level permissions are enforced inside AdminShell (AdminPageAccessGate)
 * so the sidebar never unmounts on navigation.
 */
export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isAdmin, isAuthReady, signOut } = useAuth();
  const { isStaffLoading } = useStaffProfile();
  const location = useLocation();
  const [authGateTimedOut, setAuthGateTimedOut] = useState(false);

  useEffect(() => {
    if (isAuthReady && !isStaffLoading) {
      setAuthGateTimedOut(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setAuthGateTimedOut(true);
    }, CRITICAL_BUTTON_MAX_SPINNER_MS);
    return () => window.clearTimeout(timer);
  }, [isAuthReady, isStaffLoading]);

  if ((!isAuthReady || isStaffLoading) && !authGateTimedOut) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-sidebar">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/auth" state={{ from: location.pathname }} replace />;
  }

  if (!isAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-sidebar p-4">
        <Card className="w-full max-w-md bg-card border-sidebar-border">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-destructive/20">
              <ShieldAlert className="h-8 w-8 text-destructive" />
            </div>
            <CardTitle className="text-2xl font-bold">Access Denied</CardTitle>
            <CardDescription>
              Your account is not approved for admin access.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center space-y-4">
            <p className="text-sm text-muted-foreground">
              Logged in as: <span className="font-medium">{user.email}</span>
            </p>
            <p className="text-sm text-muted-foreground">
              Please wait for an administrator to approve your access.
            </p>
            <Button onClick={signOut} variant="outline" className="w-full">
              Sign Out
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}
