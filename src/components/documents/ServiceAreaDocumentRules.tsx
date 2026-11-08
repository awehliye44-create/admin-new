import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  adminPageMutate,
  adminPageSelect,
  adminServiceAreasLookup,
} from '@/lib/adminPageGatedData';
import { Loader2, Save, MapPin, Settings2 } from 'lucide-react';
import { toast } from 'sonner';

const PAGE = 'document-management' as const;

interface ServiceArea {
  id: string;
  name: string;
  is_active: boolean;
}

interface DocType {
  id: string;
  name: string;
  slug: string;
  has_expiry: boolean;
  is_required: boolean;
  is_active: boolean;
  display_order: number | null;
}

interface RuleRow {
  doc_type_id: string;
  doc_name: string;
  doc_slug: string;
  display_in_driver_app: boolean;
  mandatory: boolean;
  expiry_required: boolean;
  sort_order: number;
  is_active: boolean;
  existsInDb: boolean;
  ruleId?: string;
  changed: boolean;
}

export function ServiceAreaDocumentRules() {
  const [serviceAreas, setServiceAreas] = useState<ServiceArea[]>([]);
  const [docTypes, setDocTypes] = useState<DocType[]>([]);
  const [selectedServiceArea, setSelectedServiceArea] = useState<string>('');
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      const [saRes, dtRes] = await Promise.all([
        adminServiceAreasLookup<ServiceArea>(PAGE, {}),
        adminPageSelect<DocType>(PAGE, 'document_types', {
          columns: [
            'id', 'name', 'slug', 'is_required', 'has_expiry', 'display_order', 'is_active',
          ],
          filters: [{ op: 'eq', col: 'is_active', val: true }],
          order: [{ col: 'display_order', asc: true }],
          limit: 500,
        }),
      ]);
      setServiceAreas(saRes.rows);
      setDocTypes(dtRes.rows);
    };
    void fetchData();
  }, []);

  const loadRules = useCallback(async (serviceAreaId: string) => {
    if (!serviceAreaId || docTypes.length === 0) return;
    setIsLoading(true);
    try {
      const { rows: existingRules } = await adminPageSelect<{
        id: string;
        doc_type_id: string;
        display_in_driver_app: boolean;
        mandatory: boolean;
        expiry_required: boolean;
        sort_order: number;
        is_active: boolean;
      }>(PAGE, 'service_area_document_rules', {
        columns: [
          'id', 'doc_type_id', 'display_in_driver_app', 'mandatory',
          'expiry_required', 'sort_order', 'is_active',
        ],
        filters: [{ op: 'eq', col: 'service_area_id', val: serviceAreaId }],
        limit: 500,
      });

      const ruleMap = new Map(existingRules.map((r) => [r.doc_type_id, r]));

      const merged: RuleRow[] = docTypes.map((dt) => {
        const existing = ruleMap.get(dt.id);
        if (existing) {
          return {
            doc_type_id: dt.id,
            doc_name: dt.name,
            doc_slug: dt.slug,
            display_in_driver_app: existing.display_in_driver_app,
            mandatory: existing.mandatory,
            expiry_required: existing.expiry_required,
            sort_order: existing.sort_order ?? 0,
            is_active: existing.is_active,
            existsInDb: true,
            ruleId: existing.id,
            changed: false,
          };
        }
        return {
          doc_type_id: dt.id,
          doc_name: dt.name,
          doc_slug: dt.slug,
          display_in_driver_app: true,
          mandatory: dt.is_required,
          expiry_required: dt.has_expiry,
          sort_order: dt.display_order ?? 0,
          is_active: true,
          existsInDb: false,
          changed: false,
        };
      });

      setRules(merged);
    } catch (err) {
      console.error('Error loading rules:', err);
      toast.error('Failed to load document rules');
    } finally {
      setIsLoading(false);
    }
  }, [docTypes]);

  useEffect(() => {
    if (selectedServiceArea) {
      void loadRules(selectedServiceArea);
    }
  }, [selectedServiceArea, loadRules]);

  const updateRule = (docTypeId: string, field: keyof RuleRow, value: unknown) => {
    setRules((prev) =>
      prev.map((r) =>
        r.doc_type_id === docTypeId ? { ...r, [field]: value, changed: true } : r
      )
    );
  };

  const handleSaveAll = async () => {
    if (!selectedServiceArea) return;
    const changedRules = rules.filter((r) => r.changed);
    if (changedRules.length === 0) {
      toast.info('No changes to save');
      return;
    }

    setIsSaving(true);
    try {
      for (const r of changedRules) {
        const patch = {
          display_in_driver_app: r.display_in_driver_app,
          mandatory: r.mandatory,
          expiry_required: r.expiry_required,
          sort_order: r.sort_order,
          is_active: r.is_active,
        };
        if (r.existsInDb && r.ruleId) {
          await adminPageMutate(PAGE, 'service_area_document_rules', 'update', {
            id: r.ruleId,
            patch,
          });
        } else {
          await adminPageMutate(PAGE, 'service_area_document_rules', 'insert', {
            patch: {
              service_area_id: selectedServiceArea,
              doc_type_id: r.doc_type_id,
              ...patch,
            },
          });
        }
      }

      setRules((prev) => prev.map((r) => ({ ...r, changed: false, existsInDb: true })));
      toast.success(`Saved ${changedRules.length} rule(s) successfully`);
      await loadRules(selectedServiceArea);
    } catch (err: any) {
      console.error('Error saving rules:', err);
      toast.error(err.message || 'Failed to save rules');
    } finally {
      setIsSaving(false);
    }
  };

  const hasChanges = rules.some((r) => r.changed);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Settings2 className="h-5 w-5 text-primary" />
          Service Area Document Rules
        </CardTitle>
        <CardDescription>
          Configure which documents are required per service area, and control visibility in the driver app
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-muted-foreground" />
            <Label>Service Area</Label>
          </div>
          <Select value={selectedServiceArea} onValueChange={setSelectedServiceArea}>
            <SelectTrigger className="w-[280px]">
              <SelectValue placeholder="Select a service area" />
            </SelectTrigger>
            <SelectContent>
              {serviceAreas.map((sa) => (
                <SelectItem key={sa.id} value={sa.id}>
                  {sa.name} {!sa.is_active && '(Inactive)'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {hasChanges && (
            <Button onClick={handleSaveAll} disabled={isSaving}>
              {isSaving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
              Save Changes
            </Button>
          )}
        </div>

        {!selectedServiceArea ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <MapPin className="h-10 w-10 mb-3 opacity-50" />
            <p>Select a service area to configure document rules</p>
          </div>
        ) : isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Document Type</TableHead>
                <TableHead className="text-center">Show in Driver App</TableHead>
                <TableHead className="text-center">Mandatory</TableHead>
                <TableHead className="text-center">Expiry Required</TableHead>
                <TableHead className="text-center">Active</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((r) => (
                <TableRow key={r.doc_type_id}>
                  <TableCell className="font-medium">{r.doc_name}</TableCell>
                  <TableCell className="text-center">
                    <Switch
                      checked={r.display_in_driver_app}
                      onCheckedChange={(v) => updateRule(r.doc_type_id, 'display_in_driver_app', v)}
                    />
                  </TableCell>
                  <TableCell className="text-center">
                    <Switch
                      checked={r.mandatory}
                      onCheckedChange={(v) => updateRule(r.doc_type_id, 'mandatory', v)}
                    />
                  </TableCell>
                  <TableCell className="text-center">
                    <Switch
                      checked={r.expiry_required}
                      onCheckedChange={(v) => updateRule(r.doc_type_id, 'expiry_required', v)}
                    />
                  </TableCell>
                  <TableCell className="text-center">
                    <Switch
                      checked={r.is_active}
                      onCheckedChange={(v) => updateRule(r.doc_type_id, 'is_active', v)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
