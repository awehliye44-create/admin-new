import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useDocumentTypes, useUpdateDocumentType, DocumentType } from "@/hooks/useDocumentTypes";
import { Settings2, Calendar, Bell, Loader2, FileText, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

export function DocumentTypeConfig() {
  const { data: documentTypes, isLoading } = useDocumentTypes();
  const updateDocumentType = useUpdateDocumentType();
  
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [selectedType, setSelectedType] = useState<DocumentType | null>(null);
  const [formData, setFormData] = useState({
    has_expiry: false,
    is_required: true,
    reminder_days: "30,14,7,3,1",
  });

  const handleEdit = (docType: DocumentType) => {
    setSelectedType(docType);
    setFormData({
      has_expiry: docType.has_expiry,
      is_required: docType.is_required,
      reminder_days: docType.reminder_days_before_expiry.join(","),
    });
    setIsEditOpen(true);
  };

  const handleSave = () => {
    if (!selectedType) return;

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
        has_expiry: formData.has_expiry,
        is_required: formData.is_required,
        reminder_days_before_expiry: formData.has_expiry ? reminderDays : [],
      },
      {
        onSuccess: () => {
          setIsEditOpen(false);
          setSelectedType(null);
        },
      }
    );
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
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings2 className="h-5 w-5 text-primary" />
            Document Type Configuration
          </CardTitle>
          <CardDescription>
            Configure expiry tracking and reminder settings for each document type
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Document Type</TableHead>
                <TableHead>Required</TableHead>
                <TableHead>Has Expiry</TableHead>
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
                      <span className="font-medium">{docType.name}</span>
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
                    <Button variant="outline" size="sm" onClick={() => handleEdit(docType)}>
                      Configure
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Configure Document Type</DialogTitle>
            <DialogDescription>{selectedType?.name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-6 py-4">
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

            {formData.has_expiry && (
              <div className="space-y-2">
                <Label htmlFor="reminderDays">Reminder Schedule (days before expiry)</Label>
                <Input
                  id="reminderDays"
                  value={formData.reminder_days}
                  onChange={(e) =>
                    setFormData({ ...formData, reminder_days: e.target.value })
                  }
                  placeholder="30,14,7,3,1"
                />
                <p className="text-xs text-muted-foreground">
                  Enter comma-separated days (e.g., 30,14,7,3,1). Reminders will be sent to
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
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
