import { ReactNode } from 'react';

interface AdminLayoutProps {
  children: ReactNode;
  title: string;
  description?: string;
  /** When true, the layout fills the available height and does not scroll.
   *  Use for full-height panels like Live Chat. */
  fullHeight?: boolean;
}

/**
 * AdminLayout now only provides page content structure.
 * The sidebar shell is handled by AdminShell at the route level.
 * This prevents re-mounting the sidebar on every page change.
 */
export function AdminLayout({ children, title, description, fullHeight }: AdminLayoutProps) {
  if (fullHeight) {
    return (
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
        <div className="px-8 pt-8 pb-4 shrink-0">
          <h1 className="text-3xl font-bold text-foreground">{title}</h1>
          {description && (
            <p className="mt-1 text-muted-foreground">{description}</p>
          )}
        </div>
        <div className="flex flex-1 min-h-0 flex-col px-8 pb-8 overflow-hidden">
          {children}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-8 min-h-full">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-foreground">{title}</h1>
        {description && (
          <p className="mt-1 text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </div>
  );
}
