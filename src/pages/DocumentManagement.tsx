import { AdminLayout } from '@/components/layout/AdminLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ListChecks, Settings2 } from 'lucide-react';
import { DocumentTypeConfig } from '@/components/documents/DocumentTypeConfig';
import { ServiceAreaDocumentRules } from '@/components/documents/ServiceAreaDocumentRules';

export default function DocumentManagement() {
  return (
    <AdminLayout
      title="Document Management"
      description="Configure document types, requirements, expiry rules, and per-service-area rules. This is the single source of truth for all document configuration."
    >
      <Tabs defaultValue="types" className="space-y-6">
        <TabsList>
          <TabsTrigger value="types" className="gap-2">
            <ListChecks className="h-4 w-4" />
            Document Types
          </TabsTrigger>
          <TabsTrigger value="rules" className="gap-2">
            <Settings2 className="h-4 w-4" />
            Service Area Rules
          </TabsTrigger>
        </TabsList>

        <TabsContent value="types">
          <DocumentTypeConfig />
        </TabsContent>

        <TabsContent value="rules">
          <ServiceAreaDocumentRules />
        </TabsContent>
      </Tabs>
    </AdminLayout>
  );
}
