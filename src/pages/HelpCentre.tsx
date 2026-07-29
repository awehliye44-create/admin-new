import { useMemo, useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Car, FolderTree, Loader2, Pencil, Plus, Search, Star, Trash2, Users } from 'lucide-react';
import {
  useDeleteHelpArticle,
  useDeleteHelpCategory,
  useHelpArticles,
  useHelpCategories,
  useSaveHelpArticle,
  useSaveHelpCategory,
  type HelpArticleRow,
  type HelpAudience,
  type HelpCategoryRow,
} from '@/hooks/useHelpCentreAdmin';
import { matchesHelpSearch, slugifyHelpTitle } from '../../shared/helpCentreSSOT';

interface CategoryDraft {
  id?: string;
  title: string;
  description: string;
  icon_key: string;
  display_order: number;
  is_active: boolean;
}

interface ArticleDraft {
  id?: string;
  category_id: string;
  title: string;
  slug: string;
  summary: string;
  body: string;
  display_order: number;
  is_featured: boolean;
  is_active: boolean;
  status: 'draft' | 'published';
}

const emptyCategory: CategoryDraft = {
  title: '',
  description: '',
  icon_key: '',
  display_order: 0,
  is_active: true,
};

const emptyArticle: ArticleDraft = {
  category_id: '',
  title: '',
  slug: '',
  summary: '',
  body: '',
  display_order: 0,
  is_featured: false,
  is_active: true,
  status: 'draft',
};

function CategoryDialog({
  audience,
  open,
  draft,
  onOpenChange,
}: {
  audience: HelpAudience;
  open: boolean;
  draft: CategoryDraft;
  onOpenChange: (open: boolean) => void;
}) {
  const [form, setForm] = useState<CategoryDraft>(draft);
  const save = useSaveHelpCategory(audience);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{form.id ? 'Edit category' : 'New category'}</DialogTitle>
          <DialogDescription>
            Categories are scoped to the {audience === 'customer' ? 'Customer' : 'Driver'} app only.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Title</Label>
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>Description</Label>
            <Textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="min-h-[70px]"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Icon key</Label>
              <Input
                value={form.icon_key}
                placeholder="e.g. car, credit-card"
                onChange={(e) => setForm({ ...form, icon_key: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>Display order</Label>
              <Input
                type="number"
                value={form.display_order}
                onChange={(e) => setForm({ ...form, display_order: Number(e.target.value) || 0 })}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
            <Label className="text-sm">Active (visible in the app)</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!form.title.trim() || save.isPending}
            onClick={() =>
              save.mutate(
                {
                  id: form.id,
                  title: form.title.trim(),
                  description: form.description.trim() || null,
                  icon_key: form.icon_key.trim() || null,
                  display_order: form.display_order,
                  is_active: form.is_active,
                },
                { onSuccess: () => onOpenChange(false) },
              )
            }
          >
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ArticleDialog({
  audience,
  open,
  draft,
  categories,
  onOpenChange,
}: {
  audience: HelpAudience;
  open: boolean;
  draft: ArticleDraft;
  categories: HelpCategoryRow[];
  onOpenChange: (open: boolean) => void;
}) {
  const [form, setForm] = useState<ArticleDraft>(draft);
  const save = useSaveHelpArticle(audience);
  const canSave = form.title.trim() && form.body.trim() && form.category_id;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{form.id ? 'Edit article' : 'New article'}</DialogTitle>
          <DialogDescription>
            This article is only ever served to the {audience === 'customer' ? 'Customer' : 'Driver'} app.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Category</Label>
            <Select value={form.category_id} onValueChange={(v) => setForm({ ...form, category_id: v })}>
              <SelectTrigger>
                <SelectValue placeholder="Select a category" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Title</Label>
            <Input
              value={form.title}
              onChange={(e) => {
                const title = e.target.value;
                setForm((prev) => ({
                  ...prev,
                  title,
                  slug: prev.id ? prev.slug : slugifyHelpTitle(title),
                }));
              }}
            />
          </div>
          <div className="space-y-1">
            <Label>Slug</Label>
            <Input
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: slugifyHelpTitle(e.target.value) })}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label>Summary</Label>
            <Input value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>Body</Label>
            <Textarea
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              className="min-h-[220px] text-sm"
              placeholder="Article content shown in the app…"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Display order</Label>
              <Input
                type="number"
                value={form.display_order}
                onChange={(e) => setForm({ ...form, display_order: Number(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-1">
              <Label>Status</Label>
              <Select
                value={form.status}
                onValueChange={(v) => setForm({ ...form, status: v as 'draft' | 'published' })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft (hidden)</SelectItem>
                  <SelectItem value="published">Published (live)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <Switch checked={form.is_featured} onCheckedChange={(v) => setForm({ ...form, is_featured: v })} />
              <Label className="text-sm">Featured</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
              <Label className="text-sm">Active</Label>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!canSave || save.isPending}
            onClick={() =>
              save.mutate(
                {
                  id: form.id,
                  category_id: form.category_id,
                  title: form.title.trim(),
                  slug: form.slug || slugifyHelpTitle(form.title),
                  summary: form.summary.trim() || null,
                  body: form.body,
                  display_order: form.display_order,
                  is_featured: form.is_featured,
                  is_active: form.is_active,
                  status: form.status,
                },
                { onSuccess: () => onOpenChange(false) },
              )
            }
          >
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AudiencePanel({ audience }: { audience: HelpAudience }) {
  const { data: categories = [], isLoading: catLoading } = useHelpCategories(audience);
  const { data: articles = [], isLoading: artLoading } = useHelpArticles(audience);
  const deleteCategory = useDeleteHelpCategory(audience);
  const deleteArticle = useDeleteHelpArticle(audience);

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [catDialog, setCatDialog] = useState<CategoryDraft | null>(null);
  const [artDialog, setArtDialog] = useState<ArticleDraft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ kind: 'category' | 'article'; id: string; label: string } | null>(
    null,
  );

  const filtered = useMemo(
    () =>
      articles.filter(
        (a) => (categoryFilter === 'all' || a.category_id === categoryFilter) && matchesHelpSearch(a, search),
      ),
    [articles, categoryFilter, search],
  );

  const categoryTitle = (id: string) => categories.find((c) => c.id === id)?.title ?? 'Uncategorised';

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <FolderTree className="h-4 w-4 text-primary" /> Categories
            </CardTitle>
            <CardDescription className="text-xs">Grouping shown at the top of the app Help Centre.</CardDescription>
          </div>
          <Button size="sm" onClick={() => setCatDialog({ ...emptyCategory })}>
            <Plus className="h-4 w-4" /> New category
          </Button>
        </CardHeader>
        <CardContent>
          {catLoading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : categories.length === 0 ? (
            <p className="text-sm text-muted-foreground">No categories yet.</p>
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {categories.map((c) => (
                <div key={c.id} className="flex items-center justify-between rounded-md border p-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">{c.title}</span>
                      {!c.is_active && <Badge variant="secondary">Hidden</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{c.description ?? '—'}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() =>
                        setCatDialog({
                          id: c.id,
                          title: c.title,
                          description: c.description ?? '',
                          icon_key: c.icon_key ?? '',
                          display_order: c.display_order,
                          is_active: c.is_active,
                        })
                      }
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive"
                      onClick={() => setConfirmDelete({ kind: 'category', id: c.id, label: c.title })}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Articles</CardTitle>
            <CardDescription className="text-xs">
              Only published, active articles inside an active category reach the app.
            </CardDescription>
          </div>
          <Button
            size="sm"
            disabled={categories.length === 0}
            onClick={() => setArtDialog({ ...emptyArticle, category_id: categories[0]?.id ?? '' })}
          >
            <Plus className="h-4 w-4" /> New article
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search title, summary or body…"
                className="pl-8"
              />
            </div>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {artLoading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No articles match your filters.</p>
          ) : (
            <div className="space-y-2">
              {filtered.map((a: HelpArticleRow) => (
                <div key={a.id} className="flex items-start justify-between rounded-md border p-3 gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {a.is_featured && <Star className="h-3.5 w-3.5 text-primary fill-primary" />}
                      <span className="font-medium text-sm">{a.title}</span>
                      <Badge variant={a.status === 'published' ? 'default' : 'secondary'}>{a.status}</Badge>
                      {!a.is_active && <Badge variant="outline">Inactive</Badge>}
                      <Badge variant="outline" className="font-normal">
                        {categoryTitle(a.category_id)}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{a.summary ?? a.body.slice(0, 160)}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() =>
                        setArtDialog({
                          id: a.id,
                          category_id: a.category_id,
                          title: a.title,
                          slug: a.slug,
                          summary: a.summary ?? '',
                          body: a.body,
                          display_order: a.display_order,
                          is_featured: a.is_featured,
                          is_active: a.is_active,
                          status: a.status,
                        })
                      }
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive"
                      onClick={() => setConfirmDelete({ kind: 'article', id: a.id, label: a.title })}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {catDialog && (
        <CategoryDialog
          key={catDialog.id ?? 'new'}
          audience={audience}
          open
          draft={catDialog}
          onOpenChange={(o) => !o && setCatDialog(null)}
        />
      )}
      {artDialog && (
        <ArticleDialog
          key={artDialog.id ?? 'new'}
          audience={audience}
          open
          draft={artDialog}
          categories={categories}
          onOpenChange={(o) => !o && setArtDialog(null)}
        />
      )}

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{confirmDelete?.label}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the {confirmDelete?.kind} and it disappears from the app immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!confirmDelete) return;
                if (confirmDelete.kind === 'category') deleteCategory.mutate(confirmDelete.id);
                else deleteArticle.mutate(confirmDelete.id);
                setConfirmDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function HelpCentre() {
  return (
    <AdminLayout
      title="Help Centre"
      description="Manage Help Centre categories and articles for the Customer App and the Driver App. Content is strictly separated by audience."
    >
      <Tabs defaultValue="customer" className="space-y-6">
        <TabsList>
          <TabsTrigger value="customer" className="gap-1.5">
            <Users className="h-3.5 w-3.5" /> Customer App
          </TabsTrigger>
          <TabsTrigger value="driver" className="gap-1.5">
            <Car className="h-3.5 w-3.5" /> Driver App
          </TabsTrigger>
        </TabsList>
        <TabsContent value="customer">
          <AudiencePanel audience="customer" />
        </TabsContent>
        <TabsContent value="driver">
          <AudiencePanel audience="driver" />
        </TabsContent>
      </Tabs>
    </AdminLayout>
  );
}
