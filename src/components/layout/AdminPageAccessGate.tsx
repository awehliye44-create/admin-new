import { useLocation } from 'react-router-dom';
import { useStaffProfile } from '@/hooks/useStaffProfile';
import { resolvePermissionSlugFromPath } from '../../../shared/adminPageCatalogSSOT';
import { Lock } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/**
 * Page-level permission gate inside AdminShell main content.
 * Must NOT live in ProtectedRoute — that would unmount the sidebar on route change.
 *
 * Path segments are normalized via the page catalog (legacy redirects → canonical slug)
 * before the exact-slug permission check.
 */
export function AdminPageAccessGate({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const { canAccessPage } = useStaffProfile();
  const pageSlug = resolvePermissionSlugFromPath(location.pathname);

  if (!canAccessPage(pageSlug)) {
    return (
      <div className="flex flex-1 min-h-0 items-center justify-center p-4">
        <Card className="w-full max-w-md bg-card border-sidebar-border">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/20">
              <Lock className="h-8 w-8 text-amber-500" />
            </div>
            <CardTitle className="text-2xl font-bold">Restricted Page</CardTitle>
            <CardDescription>
              Your role does not have permission to access this page.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center space-y-4">
            <p className="text-sm text-muted-foreground">
              Contact a Super Admin to request access.
            </p>
            <Button onClick={() => window.history.back()} variant="outline" className="w-full">
              Go Back
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}
