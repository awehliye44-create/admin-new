import { ReactNode } from 'react';

interface PageWrapperProps {
  children: ReactNode;
  title: string;
  description?: string;
}

/**
 * Page wrapper for consistent page structure.
 * Used inside pages instead of AdminLayout to avoid re-mounting sidebar.
 */
export function PageWrapper({ children, title, description }: PageWrapperProps) {
  return (
    <div className="p-8 min-h-full">
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
