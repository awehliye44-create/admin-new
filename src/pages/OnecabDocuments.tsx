import { useState, useMemo } from "react";
import { AdminLayout } from "@/components/layout/AdminLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  useOnecabDocuments,
  useCreateOnecabDocument,
  useUpdateOnecabDocument,
  useUploadOnecabFile,
  useOnecabDocumentActivity,
  getEscalationLevel,
  getDaysLeft,
  getExpiryStatus,
  type OnecabDocument,
  type OnecabDocumentInsert,
  type EscalationLevel,
} from "@/hooks/useOnecabDocuments";
import { supabase } from "@/integrations/supabase/client";
import {
  Plus, Search, Download, FileText, ShieldCheck, AlertTriangle,
  Clock, CheckCircle2, XCircle, ArrowUpCircle, Building2, Filter,
  Eye, Upload, RefreshCw, Archive,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

const CATEGORIES = ["Licence", "Insurance", "Property", "Contract", "Legal", "Compliance", "Certificate", "Other"];
const RENEWAL_STATUSES = ["none", "applied", "pending", "approved", "received"];
const RENEWAL_LABELS: Record<string, string> = { none: "None", applied: "Applied", pending: "Pending", approved: "Approved", received: "Received" };

function escalationColor(level: EscalationLevel) {
  switch (level) {
    case "expired": return "bg-red-600 text-white animate-pulse";
    case "urgent": return "bg-red-500 text-white";
    case "critical": return "bg-orange-500 text-white";
    case "warning": return "bg-amber-500 text-white";
    case "preparation": return "bg-yellow-400 text-black";
    case "safe": return "bg-emerald-500 text-white";
    case "no_expiry": return "bg-muted text-muted-foreground";
    case "archived": return "bg-muted text-muted-foreground";
  }
}

function escalationLabel(level: EscalationLevel) {
  switch (level) {
    case "expired": return "EXPIRED";
    case "urgent": return "URGENT";
    case "critical": return "CRITICAL";
    case "warning": return "WARNING";
    case "preparation": return "PREPARE";
    case "safe": return "SAFE";
    case "no_expiry": return "NO EXPIRY";
    case "archived": return "ARCHIVED";
  }
}

const escalationOrder: Record<EscalationLevel, number> = {
  expired: 0, urgent: 1, critical: 2, warning: 3, preparation: 4, safe: 5, no_expiry: 6, archived: 7,
};

function DaysLeftBadge({ doc }: { doc: OnecabDocument }) {
  const days = getDaysLeft(doc);
  const level = getEscalationLevel(doc);
  if (days === null) return <span className="text-muted-foreground text-xs">—</span>;
  return (
    <Badge className={escalationColor(level)}>
      {days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? "Today" : `${days}d left`}
    </Badge>
  );
}

// ====== DOCUMENT FORM ======
function DocumentForm({
  initial,
  onSubmit,
  onCancel,
  loading,
}: {
  initial?: Partial<OnecabDocumentInsert>;
  onSubmit: (data: OnecabDocumentInsert) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const [form, setForm] = useState<OnecabDocumentInsert>({
    title: initial?.title || "",
    category: initial?.category || "Other",
    document_type: initial?.document_type || "",
    issuing_authority: initial?.issuing_authority || "",
    reference_number: initial?.reference_number || "",
    description: initial?.description || "",
    issue_date: initial?.issue_date || "",
    expiry_date: initial?.expiry_date || "",
    reminder_days_before: initial?.reminder_days_before ?? 30,
    renewal_status: initial?.renewal_status || "none",
    notes: initial?.notes || "",
  });

  const set = (key: string, val: any) => setForm((p) => ({ ...p, [key]: val }));

  return (
    <div className="grid gap-4 max-h-[70vh] overflow-y-auto pr-2">
      <div className="grid gap-2">
        <Label>Title *</Label>
        <Input value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Taxi Operator Licence" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-2">
          <Label>Category *</Label>
          <Select value={form.category} onValueChange={(v) => set("category", v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label>Document Type</Label>
          <Input value={form.document_type || ""} onChange={(e) => set("document_type", e.target.value)} placeholder="e.g. Public Liability Insurance" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-2">
          <Label>Issuing Authority / Council</Label>
          <Input value={form.issuing_authority || ""} onChange={(e) => set("issuing_authority", e.target.value)} placeholder="e.g. Milton Keynes Council" />
        </div>
        <div className="grid gap-2">
          <Label>Reference Number</Label>
          <Input value={form.reference_number || ""} onChange={(e) => set("reference_number", e.target.value)} />
        </div>
      </div>
      <div className="grid gap-2">
        <Label>Description</Label>
        <Textarea value={form.description || ""} onChange={(e) => set("description", e.target.value)} rows={2} />
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div className="grid gap-2">
          <Label>Issue Date</Label>
          <Input type="date" value={form.issue_date || ""} onChange={(e) => set("issue_date", e.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label>Expiry Date</Label>
          <Input type="date" value={form.expiry_date || ""} onChange={(e) => set("expiry_date", e.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label>Reminder Days</Label>
          <Input type="number" value={form.reminder_days_before} onChange={(e) => set("reminder_days_before", parseInt(e.target.value) || 30)} />
        </div>
      </div>
      <div className="grid gap-2">
        <Label>Renewal Status</Label>
        <Select value={form.renewal_status} onValueChange={(v) => set("renewal_status", v)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>{RENEWAL_STATUSES.map((s) => <SelectItem key={s} value={s}>{RENEWAL_LABELS[s]}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="grid gap-2">
        <Label>Notes</Label>
        <Textarea value={form.notes || ""} onChange={(e) => set("notes", e.target.value)} rows={2} />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button onClick={() => onSubmit(form)} disabled={loading || !form.title.trim()}>
          {loading ? "Saving..." : "Save Document"}
        </Button>
      </div>
    </div>
  );
}

// ====== MAIN PAGE ======
export default function OnecabDocuments() {
  const { data: documents = [], isLoading } = useOnecabDocuments();
  const { data: activityLog = [] } = useOnecabDocumentActivity();
  const createDoc = useCreateOnecabDocument();
  const updateDoc = useUpdateOnecabDocument();
  const uploadFile = useUploadOnecabFile();

  const [createOpen, setCreateOpen] = useState(false);
  const [editDoc, setEditDoc] = useState<OnecabDocument | null>(null);
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [filterAuthority, setFilterAuthority] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [fileUploadDocId, setFileUploadDocId] = useState<string | null>(null);

  // Derived computations
  const enriched = useMemo(() => {
    return documents.map((d) => ({
      ...d,
      escalation: getEscalationLevel(d),
      daysLeft: getDaysLeft(d),
      expiryStatus: getExpiryStatus(d),
    }));
  }, [documents]);

  const filtered = useMemo(() => {
    let list = enriched;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (d) =>
          d.title.toLowerCase().includes(q) ||
          (d.document_type || "").toLowerCase().includes(q) ||
          (d.issuing_authority || "").toLowerCase().includes(q) ||
          (d.reference_number || "").toLowerCase().includes(q)
      );
    }
    if (filterCategory !== "all") list = list.filter((d) => d.category === filterCategory);
    if (filterAuthority !== "all") list = list.filter((d) => d.issuing_authority === filterAuthority);
    if (filterStatus !== "all") list = list.filter((d) => d.expiryStatus === filterStatus);

    return list.sort((a, b) => escalationOrder[a.escalation] - escalationOrder[b.escalation]);
  }, [enriched, search, filterCategory, filterAuthority, filterStatus]);

  const authorities = useMemo(() => [...new Set(documents.map((d) => d.issuing_authority).filter(Boolean) as string[])], [documents]);

  // Stats
  const stats = useMemo(() => {
    const expired = enriched.filter((d) => d.escalation === "expired").length;
    const critical = enriched.filter((d) => d.escalation === "critical" || d.escalation === "urgent").length;
    const expiring30 = enriched.filter((d) => d.daysLeft !== null && d.daysLeft >= 0 && d.daysLeft <= 30).length;
    const expiring60 = enriched.filter((d) => d.daysLeft !== null && d.daysLeft >= 0 && d.daysLeft <= 60).length;
    const active = enriched.filter((d) => d.status === "active" && d.escalation === "safe").length;
    const total = enriched.length;
    const healthScore = total > 0 ? Math.round(((total - expired - critical) / total) * 100) : 100;
    return { expired, critical, expiring30, expiring60, active, total, healthScore };
  }, [enriched]);

  // Urgent escalations
  const urgentDocs = useMemo(
    () => enriched.filter((d) => ["expired", "urgent", "critical"].includes(d.escalation)).slice(0, 10),
    [enriched]
  );

  // Authority overview
  const authorityOverview = useMemo(() => {
    const map = new Map<string, { total: number; critical: number; nextExpiry: number | null }>();
    enriched.forEach((d) => {
      const auth = d.issuing_authority || "Unknown";
      const entry = map.get(auth) || { total: 0, critical: 0, nextExpiry: null };
      entry.total++;
      if (["expired", "urgent", "critical"].includes(d.escalation)) entry.critical++;
      if (d.daysLeft !== null && (entry.nextExpiry === null || d.daysLeft < entry.nextExpiry)) entry.nextExpiry = d.daysLeft;
      map.set(auth, entry);
    });
    return Array.from(map.entries()).sort((a, b) => (a[1].nextExpiry ?? 999) - (b[1].nextExpiry ?? 999));
  }, [enriched]);

  // Category overview
  const categoryOverview = useMemo(() => {
    const map = new Map<string, { total: number; expiringSoon: number; expired: number }>();
    enriched.forEach((d) => {
      const entry = map.get(d.category) || { total: 0, expiringSoon: 0, expired: 0 };
      entry.total++;
      if (d.escalation === "expired") entry.expired++;
      else if (["urgent", "critical", "warning"].includes(d.escalation)) entry.expiringSoon++;
      map.set(d.category, entry);
    });
    return Array.from(map.entries());
  }, [enriched]);

  // Expiry forecast
  const forecast = useMemo(() => {
    const f = { d7: 0, d30: 0, d60: 0, d90: 0, d180: 0 };
    enriched.forEach((d) => {
      if (d.daysLeft === null || d.daysLeft < 0) return;
      if (d.daysLeft <= 7) f.d7++;
      if (d.daysLeft <= 30) f.d30++;
      if (d.daysLeft <= 60) f.d60++;
      if (d.daysLeft <= 90) f.d90++;
      if (d.daysLeft <= 180) f.d180++;
    });
    return f;
  }, [enriched]);

  // Renewals in progress
  const renewalDocs = useMemo(
    () => enriched.filter((d) => d.renewal_status !== "none" && d.renewal_status !== "received"),
    [enriched]
  );

  const handleCreate = async (data: OnecabDocumentInsert) => {
    await createDoc.mutateAsync(data);
    setCreateOpen(false);
  };

  const handleUpdate = async (data: OnecabDocumentInsert) => {
    if (!editDoc) return;
    await updateDoc.mutateAsync({ id: editDoc.id, ...data });
    setEditDoc(null);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !fileUploadDocId) return;
    await uploadFile.mutateAsync({ file, documentId: fileUploadDocId });
    setFileUploadDocId(null);
    toast.success("File uploaded");
  };

  const handleDownload = async (doc: OnecabDocument) => {
    if (!doc.file_path) return;
    const { data } = await supabase.storage.from("onecab-documents").createSignedUrl(doc.file_path, 300);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
  };

  const healthColor = stats.healthScore >= 90 ? "text-emerald-500" : stats.healthScore >= 70 ? "text-amber-500" : "text-red-500";

  return (
    <PageWrapper title="ONECAB Documents" description="Compliance Command Center — Company & property document management">
      {/* HEALTH BAR */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
        <Card>
          <CardContent className="pt-4 pb-3 text-center">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Health Score</p>
            <p className={`text-3xl font-black ${healthColor}`}>{stats.healthScore}%</p>
          </CardContent>
        </Card>
        <Card className={stats.expired > 0 ? "border-red-500 bg-red-500/5" : ""}>
          <CardContent className="pt-4 pb-3 text-center">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Expired</p>
            <p className={`text-3xl font-black ${stats.expired > 0 ? "text-red-500 animate-pulse" : ""}`}>{stats.expired}</p>
          </CardContent>
        </Card>
        <Card className={stats.critical > 0 ? "border-orange-500 bg-orange-500/5" : ""}>
          <CardContent className="pt-4 pb-3 text-center">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Critical</p>
            <p className={`text-3xl font-black ${stats.critical > 0 ? "text-orange-500" : ""}`}>{stats.critical}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 text-center">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Expiring 30d</p>
            <p className="text-3xl font-black text-amber-500">{stats.expiring30}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 text-center">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Expiring 60d</p>
            <p className="text-3xl font-black">{stats.expiring60}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 text-center">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Active</p>
            <p className="text-3xl font-black text-emerald-500">{stats.total}</p>
          </CardContent>
        </Card>
      </div>

      {/* URGENT ESCALATIONS */}
      {urgentDocs.length > 0 && (
        <Card className="mb-6 border-red-500/50 bg-red-500/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-red-500 flex items-center gap-2">
              <AlertTriangle className="h-5 w-5" /> Urgent Compliance Escalations
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {urgentDocs.map((d) => (
                <div key={d.id} className="flex items-center justify-between rounded-lg border p-3 bg-background">
                  <div className="flex-1">
                    <p className="font-semibold">{d.title}</p>
                    <p className="text-sm text-muted-foreground">{d.issuing_authority || "—"}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-muted-foreground">
                      {d.expiry_date ? format(new Date(d.expiry_date), "dd MMM yyyy") : "—"}
                    </span>
                    <DaysLeftBadge doc={d} />
                    <Badge variant="outline" className="text-xs">{RENEWAL_LABELS[d.renewal_status]}</Badge>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="register" className="space-y-4">
        <div className="flex flex-col sm:flex-row justify-between gap-3">
          <TabsList>
            <TabsTrigger value="register">Compliance Register</TabsTrigger>
            <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
            <TabsTrigger value="activity">Activity Log</TabsTrigger>
          </TabsList>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="h-4 w-4 mr-2" /> Add Document</Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader><DialogTitle>Add New Document</DialogTitle></DialogHeader>
              <DocumentForm onSubmit={handleCreate} onCancel={() => setCreateOpen(false)} loading={createDoc.isPending} />
            </DialogContent>
          </Dialog>
        </div>

        {/* REGISTER TAB */}
        <TabsContent value="register" className="space-y-4">
          {/* Filters */}
          <div className="flex flex-wrap gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search title, type, authority, reference..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
            </div>
            <Select value={filterCategory} onValueChange={setFilterCategory}>
              <SelectTrigger className="w-[160px]"><Filter className="h-4 w-4 mr-2" /><SelectValue placeholder="Category" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={filterAuthority} onValueChange={setFilterAuthority}>
              <SelectTrigger className="w-[200px]"><Building2 className="h-4 w-4 mr-2" /><SelectValue placeholder="Authority" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Authorities</SelectItem>
                {authorities.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger className="w-[160px]"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="Expired">Expired</SelectItem>
                <SelectItem value="Expiring Soon">Expiring Soon</SelectItem>
                <SelectItem value="Active">Active</SelectItem>
                <SelectItem value="No Expiry">No Expiry</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Main Table */}
          <Card>
            <ScrollArea className="max-h-[600px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Authority / Council</TableHead>
                    <TableHead>Ref #</TableHead>
                    <TableHead>Issue Date</TableHead>
                    <TableHead>Expiry Date</TableHead>
                    <TableHead>Days Left</TableHead>
                    <TableHead>Renewal</TableHead>
                    <TableHead>Escalation</TableHead>
                    <TableHead>File</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow><TableCell colSpan={12} className="text-center py-8">Loading...</TableCell></TableRow>
                  ) : filtered.length === 0 ? (
                    <TableRow><TableCell colSpan={12} className="text-center py-8 text-muted-foreground">No documents found</TableCell></TableRow>
                  ) : (
                    filtered.map((doc) => (
                      <TableRow key={doc.id} className={doc.escalation === "expired" ? "bg-red-500/5" : doc.escalation === "urgent" ? "bg-red-500/5" : doc.escalation === "critical" ? "bg-orange-500/5" : ""}>
                        <TableCell className="font-medium max-w-[200px] truncate">{doc.title}</TableCell>
                        <TableCell><Badge variant="outline" className="text-xs">{doc.category}</Badge></TableCell>
                        <TableCell className="text-sm text-muted-foreground max-w-[140px] truncate">{doc.document_type || "—"}</TableCell>
                        <TableCell className="text-sm max-w-[160px] truncate">{doc.issuing_authority || "—"}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{doc.reference_number || "—"}</TableCell>
                        <TableCell className="text-sm">{doc.issue_date ? format(new Date(doc.issue_date), "dd/MM/yyyy") : "—"}</TableCell>
                        <TableCell className="text-sm font-semibold">{doc.expiry_date ? format(new Date(doc.expiry_date), "dd/MM/yyyy") : "—"}</TableCell>
                        <TableCell><DaysLeftBadge doc={doc} /></TableCell>
                        <TableCell>
                          <Select
                            value={doc.renewal_status}
                            onValueChange={(v) => updateDoc.mutate({ id: doc.id, renewal_status: v })}
                          >
                            <SelectTrigger className="h-7 text-xs w-[100px]"><SelectValue /></SelectTrigger>
                            <SelectContent>{RENEWAL_STATUSES.map((s) => <SelectItem key={s} value={s}>{RENEWAL_LABELS[s]}</SelectItem>)}</SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell><Badge className={`${escalationColor(doc.escalation)} text-xs`}>{escalationLabel(doc.escalation)}</Badge></TableCell>
                        <TableCell>
                          {doc.file_path ? (
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleDownload(doc)}>
                              <Download className="h-4 w-4" />
                            </Button>
                          ) : (
                            <label className="cursor-pointer">
                              <Button variant="ghost" size="icon" className="h-7 w-7" asChild onClick={() => setFileUploadDocId(doc.id)}>
                                <span><Upload className="h-4 w-4" /></span>
                              </Button>
                            </label>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditDoc(doc)}>
                              <Eye className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => updateDoc.mutate({ id: doc.id, status: "archived" })}>
                              <Archive className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </ScrollArea>
          </Card>

          {/* Hidden file input */}
          {fileUploadDocId && (
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
              className="hidden"
              id="onecab-file-upload"
              onChange={handleFileUpload}
              ref={(el) => el?.click()}
            />
          )}
        </TabsContent>

        {/* DASHBOARD TAB */}
        <TabsContent value="dashboard" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Authority Overview */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><Building2 className="h-4 w-4" /> Authority / Council Overview</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Authority</TableHead>
                      <TableHead className="text-center">Documents</TableHead>
                      <TableHead className="text-center">Critical</TableHead>
                      <TableHead className="text-center">Next Expiry</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {authorityOverview.map(([auth, info]) => (
                      <TableRow key={auth}>
                        <TableCell className="font-medium">{auth}</TableCell>
                        <TableCell className="text-center">{info.total}</TableCell>
                        <TableCell className="text-center">
                          {info.critical > 0 ? <Badge className="bg-red-500 text-white">{info.critical}</Badge> : "0"}
                        </TableCell>
                        <TableCell className="text-center">
                          {info.nextExpiry !== null ? (
                            <span className={info.nextExpiry < 0 ? "text-red-500 font-bold" : info.nextExpiry <= 30 ? "text-amber-500 font-semibold" : ""}>
                              {info.nextExpiry < 0 ? `${Math.abs(info.nextExpiry)}d overdue` : `${info.nextExpiry}d`}
                            </span>
                          ) : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                    {authorityOverview.length === 0 && (
                      <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-4">No data</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* Category Overview */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><FileText className="h-4 w-4" /> Category Overview</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Category</TableHead>
                      <TableHead className="text-center">Total</TableHead>
                      <TableHead className="text-center">Expiring Soon</TableHead>
                      <TableHead className="text-center">Expired</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {categoryOverview.map(([cat, info]) => (
                      <TableRow key={cat} className="cursor-pointer hover:bg-muted/50" onClick={() => { setFilterCategory(cat); }}>
                        <TableCell className="font-medium">{cat}</TableCell>
                        <TableCell className="text-center">{info.total}</TableCell>
                        <TableCell className="text-center">
                          {info.expiringSoon > 0 ? <Badge className="bg-amber-500 text-white">{info.expiringSoon}</Badge> : "0"}
                        </TableCell>
                        <TableCell className="text-center">
                          {info.expired > 0 ? <Badge className="bg-red-500 text-white">{info.expired}</Badge> : "0"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* Renewal Workflow Tracker */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><RefreshCw className="h-4 w-4" /> Renewal Workflow Tracker</CardTitle>
              </CardHeader>
              <CardContent>
                {renewalDocs.length === 0 ? (
                  <p className="text-muted-foreground text-sm text-center py-4">No active renewals</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Document</TableHead>
                        <TableHead>Authority</TableHead>
                        <TableHead>Expiry</TableHead>
                        <TableHead>Renewal</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {renewalDocs.map((d) => (
                        <TableRow key={d.id}>
                          <TableCell className="font-medium">{d.title}</TableCell>
                          <TableCell className="text-sm">{d.issuing_authority || "—"}</TableCell>
                          <TableCell><DaysLeftBadge doc={d} /></TableCell>
                          <TableCell><Badge variant="outline">{RENEWAL_LABELS[d.renewal_status]}</Badge></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            {/* Expiry Forecast */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><Clock className="h-4 w-4" /> Expiry Forecast</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {[
                    { label: "Next 7 days", count: forecast.d7, color: "bg-red-500" },
                    { label: "Next 30 days", count: forecast.d30, color: "bg-orange-500" },
                    { label: "Next 60 days", count: forecast.d60, color: "bg-amber-500" },
                    { label: "Next 90 days", count: forecast.d90, color: "bg-yellow-400" },
                    { label: "Next 6 months", count: forecast.d180, color: "bg-emerald-500" },
                  ].map((item) => (
                    <div key={item.label} className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`h-3 w-3 rounded-full ${item.color}`} />
                        <span className="text-sm">{item.label}</span>
                      </div>
                      <span className="font-bold text-lg">{item.count}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ACTIVITY LOG TAB */}
        <TabsContent value="activity">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Recent Activity</CardTitle>
            </CardHeader>
            <CardContent>
              {activityLog.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">No activity yet</p>
              ) : (
                <div className="space-y-2">
                  {activityLog.map((log: any) => (
                    <div key={log.id} className="flex items-center justify-between rounded-lg border p-3">
                      <div>
                        <p className="text-sm font-medium">{log.action}</p>
                        <p className="text-xs text-muted-foreground">{log.details}</p>
                      </div>
                      <span className="text-xs text-muted-foreground">{format(new Date(log.created_at), "dd MMM yyyy HH:mm")}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Edit Dialog */}
      <Dialog open={!!editDoc} onOpenChange={(open) => !open && setEditDoc(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Edit Document</DialogTitle></DialogHeader>
          {editDoc && (
            <DocumentForm
              initial={{
                title: editDoc.title,
                category: editDoc.category,
                document_type: editDoc.document_type || "",
                issuing_authority: editDoc.issuing_authority || "",
                reference_number: editDoc.reference_number || "",
                description: editDoc.description || "",
                issue_date: editDoc.issue_date || "",
                expiry_date: editDoc.expiry_date || "",
                reminder_days_before: editDoc.reminder_days_before,
                renewal_status: editDoc.renewal_status,
                notes: editDoc.notes || "",
              }}
              onSubmit={handleUpdate}
              onCancel={() => setEditDoc(null)}
              loading={updateDoc.isPending}
            />
          )}
        </DialogContent>
      </Dialog>
    </PageWrapper>
  );
}
