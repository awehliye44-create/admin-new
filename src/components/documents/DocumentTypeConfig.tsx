import { DEFAULT_DOCUMENT_REMINDER_DAYS_INPUT, reminderDaysInputValue } from "@/lib/documentReminderDefaults";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  useDocumentTypes,
  useUpdateDocumentType,
  useCreateDocumentType,
  useDeleteDocumentType,
  DocumentType,
} from "@/hooks/useDocumentTypes";
import { Settings2, Calendar, Bell, Loader2, FileText, CheckCircle2, Plus, Eye, EyeOff, Trash2 } from "lucide-react";
import { toast } from "sonner";

export function DocumentTypeConfig() {
  const { data: documentTypes, isLoading } = useDocumentTypes();
  const updateDocumentType = useUpdateDocumentType();
  const createDocumentType = useCreateDocumentType();
  const deleteDocumentType = useDeleteDocumentType();
  
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [selectedType, setSelectedType] = useState<DocumentType | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    has_expiry: false,
    is_required: true,
    show_in_driver_app: true,
    reminder_days: DEFAULT_DOCUMENT_REMINDER_DAYS_INPUT,
  });

  const [createForm, setCreateForm] = useState({
    name: '',
    slug: '',
    description: '',
    is_required: true,
    has_expiry: false,
    show_in_driver_app: true,
    reminder_days: DEFAULT_DOCUMENT_REMINDER_DAYS_INPUT,
  });

  const handleEdit = (docType: DocumentType) => {
    setSelectedType(docType);
    setFormData({
      name: docType.name,
      description: docType.description ?? "",
      has_expiry: docType.has_expiry,
      is_required: docType.is_required,
      show_in_driver_app: docType.show_in_driver_app,
      reminder_days: reminderDaysInputValue(docType.reminder_days_before_expiry),
    });
    setIsEditOpen(true);
  };

  const handleSave = () => {
    if (!selectedType) return;
    if (!formData.name.trim()) {
      toast.error("Please enter a document type name");
      return;
    }

    const reminderDays = formData.reminder_days
      .split(",")
      .map((d) => parseInt(d.trim()))
      .filter((d) => !isNaN(d) && d > 0)
      .sort((a, b) => b - a);

    if (formData.has_expiry && reminderDays.length === 0) {
      toast.error("Please enter at least one valid reminder day");
      return;
    }

    updateDocumentType.mutate(
      {
        id: selectedType.id,
        name: formData.name.trim(),
        description: formData.description.trim() || null,
        has_expiry: formData.has_expiry,
        is_required: formData.is_required,
        show_in_driver_app: formData.show_in_driver_app,
        reminder_days_before_expiry: formData.has_expiry ? reminderDays : [],
        is_active: true,
      },
      {
        onSuccess: () => {
          setIsEditOpen(false);
          setSelectedType(null);
        },
      }
    );
  };

  const handleDelete = (docType: DocumentType) => {
    const ok = window.confirm(
      `Remove "${docType.name}"?\n\n` +
        `If drivers have already uploaded this type it will be deactivated (hidden) instead of hard-deleted.`,
    );
    if (!ok) return;
    deleteDocumentType.mutate(docType.id);
  };

  const handleRestore = (docType: DocumentType) => {
    updateDocumentType.mutate({
      id: docType.id,
      is_active: true,
      show_in_driver_app: true,
    });
  };

  const handleCreate = () => {
    if (!createForm.name.trim()) {
      toast.error("Please enter a document type name");
      return;
    }

    const slug = createForm.slug.trim() || createForm.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');

    const reminderDays = createForm.reminder_days
      .split(",")
      .map((d) => parseInt(d.trim()))
      .filter((d) => !isNaN(d) && d > 0)
      .sort((a, b) => b - a);

    createDocumentType.mutate(
      {
        name: createForm.name.trim(),
        slug,
        description: createForm.description.trim() || null,
        is_required: createForm.is_required,
        has_expiry: createForm.has_expiry,
        show_in_driver_app: createForm.show_in_driver_app,
        reminder_days_before_expiry: createForm.has_expiry ? reminderDays : [],
        display_order: (documentTypes?.length || 0) + 1,
        is_active: true,
      },
      {
        onSuccess: () => {
          setIsCreateOpen(false);
          setCreateForm({
            name: '', slug: '', description: '',
            is_required: true, has_expiry: false, show_in_driver_app: true,
            reminder_days: DEFAULT_DOCUMENT_REMINDER_DAYS_INPUT,
          });
        },
      }
    );
  };

  const openCreateDialog = () => {
    setCreateForm({
      name: '', slug: '', description: '',
      is_required: true, has_expiry: false, show_in_driver_app: true,
      reminder_days: DEFAULT_DOCUMENT_REMINDER_DAYS_INPUT,
    });
    setIsCreateOpen(true);
  };

  const handleQuickToggleVisibility = (docType: DocumentType) => {
    updateDocumentType.mutate({
      id: docType.id,
      show_in_driver_app: !docType.show_in_driver_app,
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Settings2 className="h-5 w-5 text-primary" />
              Document Type Configuration
            </CardTitle>
            <CardDescription>
              Manage document types and create new ones. Changes apply instantly to the driver app.
            </CardDescription>
          </div>
          <Button onClick={openCreateDialog}>
            <Plus className="h-4 w-4 mr-2" />
            Add Document Type
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Document Type</TableHead>
                <TableHead>Required</TableHead>
                <TableHead>Has Expiry</TableHead>
                <TableHead>Driver App</TableHead>
                <TableHead>Reminder Schedule</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {documentTypes?.map((docType) => (
                <TableRow key={docType.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{docType.name}</span>
                          {!docType.is_active && (
                            <Badge variant="outline" className="bg-red-50 text-red-700">
                              Inactive
                            </Badge>
                          )}
                        </div>
                        {docType.description && (
                          <p className="text-xs text-muted-foreground">{docType.description}</p>
                        )}
                        <p className="text-[11px] font-mono text-muted-foreground">{docType.slug}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    {docType.is_required ? (
                      <Badge variant="outline" className="bg-green-100 text-green-700">
                        <CheckCircle2 className="h-3 w-3 mr-1" />
                        Required
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="bg-gray-100 text-gray-600">
                        Optional
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {docType.has_expiry ? (
                      <Badge variant="outline" className="bg-orange-100 text-orange-700">
                        <Calendar className="h-3 w-3 mr-1" />
                        Has Expiry
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="bg-gray-100 text-gray-600">
                        No Expiry
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <button
                      onClick={() => handleQuickToggleVisibility(docType)}
                      className="inline-flex items-center gap-1 cursor-pointer"
                      title={docType.show_in_driver_app ? "Visible in driver app — click to hide" : "Hidden from driver app — click to show"}
                    >
                      {docType.show_in_driver_app ? (
                        <Badge variant="outline" className="bg-blue-100 text-blue-700 border-blue-200">
                          <Eye className="h-3 w-3 mr-1" />
                          Visible
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="bg-red-100 text-red-700 border-red-200">
                          <EyeOff className="h-3 w-3 mr-1" />
                          Hidden
                        </Badge>
                      )}
                    </button>
                  </TableCell>
                  <TableCell>
                    {docType.has_expiry && docType.reminder_days_before_expiry.length > 0 ? (
                      <div className="flex items-center gap-1">
                        <Bell className="h-3 w-3 text-muted-foreground" />
                        <span className="text-sm text-muted-foreground">
                          {docType.reminder_days_before_expiry.join(", ")} days before
                        </span>
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="inline-flex items-center gap-2">
                      {!docType.is_active ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRestore(docType)}
                          disabled={updateDocumentType.isPending}
                        >
                          Restore
                        </Button>
                      ) : (
                        <Button variant="outline" size="sm" onClick={() => handleEdit(docType)}>
                          Edit / Rename
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive border-destructive/30 hover:bg-destructive/10"
                        onClick={() => handleDelete(docType)}
                        disabled={deleteDocumentType.isPending}
                        title="Delete or deactivate"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit / Rename Document Type</DialogTitle>
            <DialogDescription>
              Rename and reuse this type. Driver uploads stay linked via the internal slug.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit_name">Display name</Label>
              <Input
                id="edit_name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g. Additional Insurance Document"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit_desc">Description</Label>
              <Textarea
                id="edit_desc"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                rows={2}
              />
            </div>
            {selectedType?.slug && (
              <div className="space-y-1 rounded-md border bg-muted/40 px-3 py-2">
                <Label className="text-xs text-muted-foreground">Internal slug (not renamed — keeps existing uploads)</Label>
                <p className="font-mono text-sm">{selectedType.slug}</p>
              </div>
            )}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Required Document</Label>
                <p className="text-sm text-muted-foreground">
                  Drivers must upload this document for approval
                </p>
              </div>
              <Switch
                checked={formData.is_required}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, is_required: checked })
                }
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Has Expiry Date</Label>
                <p className="text-sm text-muted-foreground">
                  This document type requires an expiry date
                </p>
              </div>
              <Switch
                checked={formData.has_expiry}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, has_expiry: checked })
                }
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Show in Driver App</Label>
                <p className="text-sm text-muted-foreground">
                  When OFF, this document is hidden from the driver app globally
                </p>
              </div>
              <Switch
                checked={formData.show_in_driver_app}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, show_in_driver_app: checked })
                }
              />
            </div>

            {formData.has_expiry && (
              <div className="space-y-2">
                <Label htmlFor="reminderDays">Reminder Schedule (days before expiry)</Label>
                <Input
                  id="reminderDays"
                  value={formData.reminder_days}
                  onChange={(e) =>
                    setFormData({ ...formData, reminder_days: e.target.value })
                  }
                  placeholder={DEFAULT_DOCUMENT_REMINDER_DAYS_INPUT}
                />
                <p className="text-xs text-muted-foreground">
                  Enter comma-separated days (e.g., 7,3,1). Reminders will be sent to
                  drivers on these days before expiry.
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={updateDocumentType.isPending}>
              {updateDocumentType.isPending && (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              )}
              Save name & settings
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create New Document Type Dialog */}
      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Document Type</DialogTitle>
            <DialogDescription>
              Add a new document type. It will be available for all service areas.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="create_name">Document Name *</Label>
              <Input
                id="create_name"
                value={createForm.name}
                onChange={(e) => setCreateForm(prev => ({ ...prev, name: e.target.value }))}
                placeholder="e.g., DBS Certificate"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create_slug">Slug (auto-generated if blank)</Label>
              <Input
                id="create_slug"
                value={createForm.slug}
                onChange={(e) => setCreateForm(prev => ({ ...prev, slug: e.target.value }))}
                placeholder="e.g., dbs_certificate"
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create_desc">Description</Label>
              <Textarea
                id="create_desc"
                value={createForm.description}
                onChange={(e) => setCreateForm(prev => ({ ...prev, description: e.target.value }))}
                placeholder="Brief description of this document"
                rows={2}
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Default Mandatory</Label>
                <p className="text-xs text-muted-foreground">Required by default in service areas</p>
              </div>
              <Switch
                checked={createForm.is_required}
                onCheckedChange={(checked) => setCreateForm(prev => ({ ...prev, is_required: checked }))}
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Default Expiry Required</Label>
                <p className="text-xs text-muted-foreground">Requires expiry date by default</p>
              </div>
              <Switch
                checked={createForm.has_expiry}
                onCheckedChange={(checked) => setCreateForm(prev => ({ ...prev, has_expiry: checked }))}
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Default Show in Driver App</Label>
                <p className="text-xs text-muted-foreground">Visible in driver app by default</p>
              </div>
              <Switch
                checked={createForm.show_in_driver_app}
                onCheckedChange={(checked) => setCreateForm(prev => ({ ...prev, show_in_driver_app: checked }))}
              />
            </div>
            {createForm.has_expiry && (
              <div className="space-y-2">
                <Label>Reminder Schedule (days before expiry)</Label>
                <Input
                  value={createForm.reminder_days}
                  onChange={(e) => setCreateForm(prev => ({ ...prev, reminder_days: e.target.value }))}
                  placeholder={DEFAULT_DOCUMENT_REMINDER_DAYS_INPUT}
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={createDocumentType.isPending}>
              {createDocumentType.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Create Document Type
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}