import { useState, useEffect, useCallback } from 'react';
import DOMPurify from 'dompurify';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Save, Send, Phone, Building2, Car, Users, Loader2, Eye, Code2, Globe, Scale } from 'lucide-react';

type AppScope = 'customer' | 'driver' | 'corporate' | 'shared' | 'legal';

interface ContentItem {
  id: string;
  app_scope: AppScope;
  slug: string;
  title: string;
  content_html: string;
  status: 'draft' | 'published';
  version: number;
  change_log: string | null;
  updated_at: string;
  published_at: string | null;
}

const PLAIN_TEXT_SLUGS = ['company_name', 'support_phone', 'whatsapp_phone', 'support_email'];

function ContentEditor({ item, onSaved }: { item: ContentItem; onSaved: () => void }) {
  const [content, setContent] = useState(item.content_html);
  const [changeLog, setChangeLog] = useState('');
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const isPlainText = PLAIN_TEXT_SLUGS.includes(item.slug);
  const isDirty = content !== item.content_html;

  useEffect(() => {
    setContent(item.content_html);
  }, [item.id, item.content_html]);

  const handleSaveDraft = async () => {
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('content_items')
        .update({
          content_html: content,
          change_log: changeLog || null,
          updated_by: user.id,
          status: 'draft' as any,
        })
        .eq('id', item.id);

      if (error) throw error;

      await supabase.from('content_audit_log').insert({
        content_item_id: item.id,
        action: 'draft_saved',
        user_id: user.id,
        details: { change_log: changeLog, version: item.version },
      } as any);

      toast.success('Draft saved');
      setChangeLog('');
      onSaved();
    } catch (e: any) {
      toast.error(e.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async () => {
    setPublishing(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { error: updateErr } = await supabase
        .from('content_items')
        .update({
          content_html: content,
          status: 'published' as any,
          change_log: changeLog || null,
          updated_by: user.id,
          published_by: user.id,
          published_at: new Date().toISOString(),
        })
        .eq('id', item.id);

      if (updateErr) throw updateErr;

      const newVersion = item.version + 1;
      await supabase.from('content_items').insert({
        app_scope: item.app_scope as any,
        slug: item.slug,
        title: item.title,
        content_html: content,
        status: 'draft' as any,
        version: newVersion,
        updated_by: user.id,
      } as any);

      await supabase.from('content_audit_log').insert({
        content_item_id: item.id,
        action: 'published',
        user_id: user.id,
        details: { change_log: changeLog, version: item.version, new_version: newVersion },
      } as any);

      toast.success(`Published v${item.version}. New draft v${newVersion} created.`);
      setChangeLog('');
      onSaved();
    } catch (e: any) {
      toast.error(e.message || 'Failed to publish');
    } finally {
      setPublishing(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">{item.title}</CardTitle>
            <CardDescription className="text-xs mt-1">
              v{item.version} · <span className="font-mono text-[10px] text-muted-foreground/70">{item.slug}</span> · Updated {new Date(item.updated_at).toLocaleDateString()}
              {item.published_at && ` · Published ${new Date(item.published_at).toLocaleDateString()}`}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {!isPlainText && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => setShowPreview(!showPreview)}
                title={showPreview ? 'Show editor' : 'Show preview'}
              >
                {showPreview ? <Code2 className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </Button>
            )}
            <Badge variant={item.status === 'published' ? 'default' : 'secondary'}>
              {item.status}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {isPlainText ? (
          <Input
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={`Enter ${item.title.toLowerCase()}`}
          />
        ) : showPreview ? (
          <div
            className="prose prose-sm max-w-none rounded-md border border-input bg-background p-4 min-h-[200px] overflow-auto"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content) }}
          />
        ) : (
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Enter HTML content…"
            className="min-h-[200px] font-mono text-xs"
          />
        )}

        <div className="space-y-1">
          <Label className="text-xs">Change log (optional)</Label>
          <Input
            value={changeLog}
            onChange={(e) => setChangeLog(e.target.value)}
            placeholder="Describe what changed…"
            className="text-sm"
          />
        </div>

        <div className="flex gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            onClick={handleSaveDraft}
            disabled={saving || !isDirty}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save Draft
          </Button>
          <Button
            size="sm"
            onClick={handlePublish}
            disabled={publishing}
          >
            {publishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Publish
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ScopeSection({ scope, icon, items, onRefresh, apiParam }: {
  scope: string;
  icon: React.ReactNode;
  items: ContentItem[];
  onRefresh: () => void;
  apiParam?: string;
}) {
  if (items.length === 0) return null;

  const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
  const apiUrl = apiParam
    ? `https://${projectId}.supabase.co/functions/v1/public-content?app=${apiParam}`
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-lg font-semibold">
          {icon}
          {scope}
        </div>
      </div>

      {apiUrl && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="py-3 px-4">
            <div className="flex items-center gap-2 text-xs">
              <Globe className="h-3.5 w-3.5 text-primary shrink-0" />
              <span className="text-muted-foreground">Public API for apps:</span>
              <code className="font-mono text-[11px] bg-background px-2 py-0.5 rounded border break-all">
                GET {apiUrl}
              </code>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1 ml-5">
              Returns latest <strong>published</strong> content + shared fields (company name, phone, email). Draft content is not exposed.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {items.map((item) => (
          <ContentEditor key={item.id} item={item} onSaved={onRefresh} />
        ))}
      </div>
    </div>
  );
}

export default function ManageContent() {
  const [items, setItems] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('content_items')
      .select('*')
      .order('version', { ascending: false });

    if (error) {
      toast.error('Failed to load content');
      setLoading(false);
      return;
    }

    const seen = new Set<string>();
    const latest: ContentItem[] = [];
    for (const row of (data || [])) {
      const key = `${row.app_scope}:${row.slug}`;
      if (!seen.has(key)) {
        seen.add(key);
        latest.push(row as ContentItem);
      }
    }
    setItems(latest);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const byScope = (scope: AppScope) => items.filter(i => i.app_scope === scope);

  return (
    <AdminLayout title="Manage Content" description="Edit app content and legal documents — changes here are served live to Customer App, Driver App, and the Corporate website via API.">
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <Tabs defaultValue="contact" className="space-y-6">
          <TabsList className="flex-wrap h-auto gap-1">
            <TabsTrigger value="contact" className="gap-1.5">
              <Phone className="h-3.5 w-3.5" /> Contact & Branding
            </TabsTrigger>
            <TabsTrigger value="customer" className="gap-1.5">
              <Users className="h-3.5 w-3.5" /> Customer App
            </TabsTrigger>
            <TabsTrigger value="driver" className="gap-1.5">
              <Car className="h-3.5 w-3.5" /> Driver App
            </TabsTrigger>
            <TabsTrigger value="corporate" className="gap-1.5">
              <Building2 className="h-3.5 w-3.5" /> Corporate Page
            </TabsTrigger>
            <TabsTrigger value="legal" className="gap-1.5">
              <Scale className="h-3.5 w-3.5" /> Legal Content
            </TabsTrigger>
          </TabsList>

          <TabsContent value="contact">
            <ScopeSection
              scope="Contact & Branding"
              icon={<Phone className="h-5 w-5 text-primary" />}
              items={byScope('shared')}
              onRefresh={fetchItems}
            />
          </TabsContent>

          <TabsContent value="customer">
            <ScopeSection
              scope="Customer App Content"
              icon={<Users className="h-5 w-5 text-primary" />}
              items={byScope('customer')}
              onRefresh={fetchItems}
              apiParam="customer"
            />
          </TabsContent>

          <TabsContent value="driver">
            <ScopeSection
              scope="Driver App Content"
              icon={<Car className="h-5 w-5 text-primary" />}
              items={byScope('driver')}
              onRefresh={fetchItems}
              apiParam="driver"
            />
          </TabsContent>

          <TabsContent value="corporate">
            <ScopeSection
              scope="Corporate Page"
              icon={<Building2 className="h-5 w-5 text-primary" />}
              items={byScope('corporate')}
              onRefresh={fetchItems}
              apiParam="corporate"
            />
          </TabsContent>

          <TabsContent value="legal">
            <ScopeSection
              scope="Legal Content"
              icon={<Scale className="h-5 w-5 text-primary" />}
              items={byScope('legal')}
              onRefresh={fetchItems}
              apiParam="legal"
            />
          </TabsContent>
        </Tabs>
      )}
    </AdminLayout>
  );
}
