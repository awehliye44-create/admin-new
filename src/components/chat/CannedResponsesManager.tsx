import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Trash2, Plus, Edit2, Zap } from "lucide-react";
import { useCannedResponses, useSaveCannedResponse, useDeleteCannedResponse, CannedResponse } from "@/hooks/useSupportChat";

export function CannedResponsesManager() {
  const { data: responses = [], isLoading } = useCannedResponses();
  const saveMutation = useSaveCannedResponse();
  const deleteMutation = useDeleteCannedResponse();
  const [isOpen, setIsOpen] = useState(false);
  const [editing, setEditing] = useState<CannedResponse | null>(null);
  const [form, setForm] = useState({ title: "", content: "", category: "", shortcut: "" });

  const openNew = () => {
    setEditing(null);
    setForm({ title: "", content: "", category: "", shortcut: "" });
    setIsOpen(true);
  };

  const openEdit = (r: CannedResponse) => {
    setEditing(r);
    setForm({ title: r.title, content: r.content, category: r.category || "", shortcut: r.shortcut || "" });
    setIsOpen(true);
  };

  const handleSave = () => {
    saveMutation.mutate(
      { id: editing?.id, title: form.title, content: form.content, category: form.category || undefined, shortcut: form.shortcut || undefined },
      { onSuccess: () => setIsOpen(false) }
    );
  };

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Zap className="h-4 w-4 text-primary" />
            Canned Responses
          </CardTitle>
          <Button size="sm" onClick={openNew}>
            <Plus className="h-4 w-4 mr-1" /> Add
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : responses.length === 0 ? (
            <p className="text-sm text-muted-foreground">No canned responses yet. Add quick replies for common questions.</p>
          ) : (
            <div className="space-y-2">
              {responses.map((r) => (
                <div key={r.id} className="flex items-start justify-between gap-3 p-3 border rounded-lg">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-sm">{r.title}</p>
                      {r.shortcut && <span className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{r.shortcut}</span>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 truncate">{r.content}</p>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(r)}>
                      <Edit2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => { if (confirm("Delete this response?")) deleteMutation.mutate(r.id); }}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit" : "New"} Canned Response</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Title *</Label>
              <Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. Greeting" />
            </div>
            <div>
              <Label>Content *</Label>
              <Textarea value={form.content} onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))} rows={3} placeholder="The message text..." />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Category</Label>
                <Input value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} placeholder="e.g. General" />
              </div>
              <div>
                <Label>Shortcut</Label>
                <Input value={form.shortcut} onChange={(e) => setForm((f) => ({ ...f, shortcut: e.target.value }))} placeholder="e.g. /hello" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={!form.title.trim() || !form.content.trim()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
