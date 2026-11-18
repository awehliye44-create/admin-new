/**
 * Loads Admin Add Documents checklist for a driver:
 * SA rules (active + display_in_driver_app) + compliance SSOT + type meta.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { adminPageSelect } from '@/lib/adminPageGatedData';
import {
  composeAdminDriverDocumentChecklist,
  type DocumentTypeMeta,
  type ServiceAreaDocumentRule,
} from '@/lib/adminDriverDocumentChecklist';
import type { DriverDocumentComplianceRow } from '@/hooks/useDriverDocumentCompliance';

const PAGE = 'drivers' as const;

async function fetchCompliance(driverId: string): Promise<DriverDocumentComplianceRow[]> {
  const { data, error } = await supabase.rpc('get_driver_document_compliance', {
    _driver_id: driverId,
  });
  if (error) throw error;
  return (data ?? []) as DriverDocumentComplianceRow[];
}

export function useAdminDriverDocumentChecklist(driverId: string | null | undefined) {
  return useQuery({
    queryKey: ['admin-driver-document-checklist', driverId],
    enabled: !!driverId,
    staleTime: 15_000,
    queryFn: async () => {
      const id = driverId!;

      const { rows: dsaRows } = await adminPageSelect<{ service_area_id: string }>(
        PAGE,
        'driver_service_areas',
        {
          columns: ['service_area_id'],
          filters: [{ op: 'eq', col: 'driver_id', val: id }],
          limit: 20,
        },
      );

      const serviceAreaId = dsaRows[0]?.service_area_id ?? null;
      if (!serviceAreaId) {
        return {
          serviceAreaId: null as string | null,
          rows: composeAdminDriverDocumentChecklist({
            driverId: id,
            rules: [],
            typeMetaById: new Map(),
            complianceRows: [],
          }),
          rulesConfigured: false,
        };
      }

      const [{ rows: ruleRows }, complianceRows] = await Promise.all([
        adminPageSelect<ServiceAreaDocumentRule & { id?: string }>(
          PAGE,
          'service_area_document_rules',
          {
            columns: [
              'doc_type_id',
              'display_in_driver_app',
              'mandatory',
              'expiry_required',
              'sort_order',
              'is_active',
            ],
            filters: [{ op: 'eq', col: 'service_area_id', val: serviceAreaId }],
            order: [{ col: 'sort_order', asc: true }],
            limit: 500,
          },
        ),
        fetchCompliance(id),
      ]);

      const visibleTypeIds = ruleRows
        .filter((r) => r.is_active === true && r.display_in_driver_app === true)
        .map((r) => r.doc_type_id);

      const typeMetaById = new Map<string, DocumentTypeMeta>();
      if (visibleTypeIds.length > 0) {
        const { rows: types } = await adminPageSelect<DocumentTypeMeta>(PAGE, 'document_types', {
          columns: ['id', 'slug', 'name', 'is_required', 'has_expiry', 'is_active'],
          filters: [{ op: 'in', col: 'id', val: visibleTypeIds }],
          limit: 500,
        });
        for (const t of types) {
          if (t?.id) typeMetaById.set(t.id, t);
        }
      }

      return {
        serviceAreaId,
        rulesConfigured: ruleRows.length > 0,
        rows: composeAdminDriverDocumentChecklist({
          driverId: id,
          rules: ruleRows,
          typeMetaById,
          complianceRows,
        }),
      };
    },
  });
}
