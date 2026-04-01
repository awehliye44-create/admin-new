import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  ArrowLeft, Send, Lock, Unlock, XCircle, RefreshCw, Eye, MessageSquare,
  Image as ImageIcon, Clock, CheckCircle, AlertTriangle, Package, Loader2,
  Sparkles, Bot,
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import {
  useLostPropertyCase,
  useLostPropertyMessages,
  useLostPropertyActions,
  useLostPropertyRealtime,
  LP_STATUS_LABELS,
  LP_STATUS_COLORS,
} from '@/hooks/useLostProperty';
import { useServiceAreas } from '@/hooks/useServiceAreas';
import { supabase } from '@/integrations/supabase/client';

const STATUS_ORDER = [
  'NEW', 'SENT_TO_DRIVER', 'DRIVER_CONFIRMED_FOUND', 'AWAITING_CUSTOMER_CONFIRMATION',
  'AWAITING_RETURN_METHOD', 'AWAITING_COLLECTION', 'RETURN_RIDE_REQUESTED',
  'RETURN_RIDE_BOOKED', 'CLOSED',
];

export default function LostPropertyDetail() {
  const { caseId } = useParams<{ caseId: string }>();
  const navigate = useNavigate();
  const { data: lpCase, isLoading } = useLostPropertyCase(caseId);
  const { data: messages = [], isLoading: msgsLoading } = useLostPropertyMessages(caseId);
  const actions = useLostPropertyActions();
  const { data: serviceAreas = [] } = useServiceAreas({ activeOnly: false });
  const saMap = new Map(serviceAreas.map(sa => [sa.id, sa.name]));

  useLostPropertyRealtime(caseId);

  const [msgInput, setMsgInput] = useState('');
  const [sending, setSending] = useState(false);
  const [aiLoading, setAiLoading] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Mark viewed on mount
  useEffect(() => {
    if (caseId && lpCase && !lpCase.admin_viewed_at) {
      actions.adminMarkViewed.mutate(caseId);
    }
  }, [caseId, lpCase?.admin_viewed_at]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  if (isLoading) {
    return (
      <AdminLayout title="Lost Property" description="Loading...">
        <div className="flex items-center justify-center py-32">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  if (!lpCase) {
    return (
      <AdminLayout title="Lost Property" description="Case not found">
        <div className="text-center py-20 text-muted-foreground">
          <Package className="h-12 w-12 mx-auto mb-4 opacity-40" />
          <p>Case not found</p>
          <Button variant="outline" className="mt-4" onClick={() => navigate('/lost-property')}>
            <ArrowLeft className="h-4 w-4 mr-2" /> Back to List
          </Button>
        </div>
      </AdminLayout>
    );
  }

  const photosDeleted = lpCase.photos_delete_at && new Date(lpCase.photos_delete_at) < new Date();
  const chatExpired = new Date(lpCase.chat_expires_at) < new Date();
  const isClosed = lpCase.status === 'CLOSED';

  const handleSendMessage = async () => {
    if (!msgInput.trim() || !caseId) return;
    setSending(true);
    try {
      await actions.adminSendMessage.mutateAsync({ case_id: caseId, message: msgInput.trim() });
      setMsgInput('');
      toast.success('Message sent');
    } catch (e: any) {
      toast.error(e.message || 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  const handleAction = async (
    action: 'adminCloseCase' | 'adminOpenCase' | 'adminReopenCase' | 'adminLockChat' | 'adminUnlockChat',
    label: string
  ) => {
    if (!caseId) return;
    try {
      await actions[action].mutateAsync(caseId);
      toast.success(label);
    } catch (e: any) {
      toast.error(e.message || `Failed: ${label}`);
    }
  };

  const handleAI = async (type: 'summary' | 'reply' | 'priority') => {
    if (!caseId) return;
    setAiLoading(type);
    setAiResult(null);
    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/lost-property-ai?type=${type}`;
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ case_id: caseId }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'AI request failed');
      setAiResult(data.result);
    } catch (e: any) {
      toast.error(e.message || 'AI helper failed');
    } finally {
      setAiLoading(null);
    }
  };

  const senderLabel = (type: string) => {
    switch (type.toUpperCase()) {
      case 'RIDER': case 'CUSTOMER': return 'Customer';
      case 'DRIVER': return 'Driver';
      case 'SUPPORT': return 'Support';
      case 'SYSTEM': return 'System';
      default: return type;
    }
  };

  const senderColor = (type: string) => {
    switch (type.toUpperCase()) {
      case 'RIDER': case 'CUSTOMER': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
      case 'DRIVER': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
      case 'SUPPORT': return 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300';
      case 'SYSTEM': return 'bg-muted text-muted-foreground';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  const currentIdx = STATUS_ORDER.indexOf(lpCase.status);

  return (
    <AdminLayout
      title={`Case ${lpCase.case_number}`}
      description="Lost Property Case Detail"
    >
      {/* Back + Header */}
      <div className="flex items-center justify-between mb-6">
        <Button variant="ghost" size="sm" onClick={() => navigate('/lost-property')}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back
        </Button>
        <div className="flex items-center gap-2">
          <Badge className={`${LP_STATUS_COLORS[lpCase.status] || 'bg-gray-500'} text-white`}>
            {LP_STATUS_LABELS[lpCase.status] || lpCase.status}
          </Badge>
          {!lpCase.chat_enabled && (
            <Badge variant="outline" className="border-destructive text-destructive">
              <Lock className="h-3 w-3 mr-1" /> Chat Locked
            </Badge>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* LEFT: Details + Photos + Timeline */}
        <div className="lg:col-span-1 space-y-4">
          {/* Ticket Details */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Case Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Case ID" value={lpCase.case_number} />
              <Row label="Trip ID" value={lpCase.trip_id?.slice(0, 12) + '...'} mono />
              <Row label="Service Area" value={saMap.get(lpCase.service_area_id) || '—'} />
              <Row label="Category" value={<Badge variant="outline" className="capitalize">{lpCase.item_category}</Badge>} />
              <Row label="Description" value={lpCase.item_description} />
              <Separator />
              <Row label="Customer" value={lpCase.customer_id?.slice(0, 8) + '...'} mono />
              <Row label="Driver" value={lpCase.driver_id?.slice(0, 8) + '...'} mono />
              <Separator />
              <Row label="Chat Status" value={lpCase.chat_enabled ? '🟢 Open' : '🔴 Locked'} />
              <Row label="Chat Expiry" value={chatExpired ? 'Expired' : formatDistanceToNow(new Date(lpCase.chat_expires_at), { addSuffix: true })} />
              <Row label="Return Method" value={lpCase.return_method || '—'} />
              {lpCase.return_trip_id && <Row label="Return Booking" value={lpCase.return_trip_id.slice(0, 8) + '...'} mono />}
              <Separator />
              <Row label="Created" value={format(new Date(lpCase.created_at), 'dd MMM yyyy HH:mm')} />
              <Row label="Updated" value={format(new Date(lpCase.updated_at), 'dd MMM yyyy HH:mm')} />
            </CardContent>
          </Card>

          {/* Photos */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <ImageIcon className="h-4 w-4" /> Uploaded Photos
              </CardTitle>
            </CardHeader>
            <CardContent>
              {photosDeleted ? (
                <div className="text-sm text-muted-foreground italic py-4 text-center">
                  📷 Photos deleted for privacy
                </div>
              ) : (
                <div className="space-y-3">
                  {lpCase.photos && lpCase.photos.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-2">Customer Photos</p>
                      <div className="grid grid-cols-2 gap-2">
                        {lpCase.photos.map((p, i) => (
                          <PhotoThumbnail key={i} path={p} label="Customer" />
                        ))}
                      </div>
                    </div>
                  )}
                  {lpCase.found_item_photos && lpCase.found_item_photos.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-2">Driver Confirmation Photos</p>
                      <div className="grid grid-cols-2 gap-2">
                        {lpCase.found_item_photos.map((p, i) => (
                          <PhotoThumbnail key={i} path={p} label="Driver" />
                        ))}
                      </div>
                    </div>
                  )}
                  {(!lpCase.photos || lpCase.photos.length === 0) && (!lpCase.found_item_photos || lpCase.found_item_photos.length === 0) && (
                    <p className="text-sm text-muted-foreground text-center py-4">No photos uploaded</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Status Timeline */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Status Progress</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                {STATUS_ORDER.map((s, i) => {
                  const reached = i <= currentIdx || lpCase.status === 'ESCALATED' || lpCase.status === 'DRIVER_NOT_FOUND';
                  const isCurrent = lpCase.status === s;
                  return (
                    <div key={s} className="flex items-center gap-2 py-1">
                      <div className={`h-2.5 w-2.5 rounded-full shrink-0 ${isCurrent ? 'bg-primary ring-2 ring-primary/30' : reached ? 'bg-green-500' : 'bg-muted'}`} />
                      <span className={`text-xs ${isCurrent ? 'font-semibold text-foreground' : reached ? 'text-muted-foreground' : 'text-muted-foreground/50'}`}>
                        {LP_STATUS_LABELS[s]}
                      </span>
                    </div>
                  );
                })}
                {/* Show special statuses if active */}
                {(lpCase.status === 'ESCALATED' || lpCase.status === 'DRIVER_NOT_FOUND') && (
                  <div className="flex items-center gap-2 py-1">
                    <div className="h-2.5 w-2.5 rounded-full shrink-0 bg-red-500 ring-2 ring-red-500/30" />
                    <span className="text-xs font-semibold text-foreground">{LP_STATUS_LABELS[lpCase.status]}</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Admin Actions */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Admin Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {!isClosed && (
                <Button variant="destructive" size="sm" className="w-full" onClick={() => handleAction('adminCloseCase', 'Case closed')} disabled={actions.adminCloseCase.isPending}>
                  <XCircle className="h-4 w-4 mr-2" /> Close Case
                </Button>
              )}
              {isClosed && (
                <Button variant="default" size="sm" className="w-full" onClick={() => handleAction('adminReopenCase', 'Case reopened')} disabled={actions.adminReopenCase.isPending}>
                  <RefreshCw className="h-4 w-4 mr-2" /> Reopen Case
                </Button>
              )}
              {!isClosed && lpCase.status !== 'ESCALATED' && (
                <Button variant="outline" size="sm" className="w-full" onClick={() => handleAction('adminOpenCase', 'Case escalated')} disabled={actions.adminOpenCase.isPending}>
                  <AlertTriangle className="h-4 w-4 mr-2" /> Escalate
                </Button>
              )}
              <Separator />
              {lpCase.chat_enabled ? (
                <Button variant="outline" size="sm" className="w-full" onClick={() => handleAction('adminLockChat', 'Chat locked')} disabled={actions.adminLockChat.isPending}>
                  <Lock className="h-4 w-4 mr-2" /> Lock Chat
                </Button>
              ) : (
                !isClosed && (
                  <Button variant="outline" size="sm" className="w-full" onClick={() => handleAction('adminUnlockChat', 'Chat unlocked')} disabled={actions.adminUnlockChat.isPending}>
                    <Unlock className="h-4 w-4 mr-2" /> Unlock Chat
                  </Button>
                )
              )}
            </CardContent>
          </Card>
        </div>

        {/* RIGHT: Chat + AI */}
        <div className="lg:col-span-2 space-y-4">
          {/* Chat */}
          <Card className="flex flex-col" style={{ height: '520px' }}>
            <CardHeader className="pb-2 shrink-0">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <MessageSquare className="h-4 w-4" /> Chat History
                {lpCase.admin_joined_at && (
                  <Badge variant="secondary" className="text-xs">Support Joined</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col overflow-hidden p-0">
              <ScrollArea className="flex-1 px-4">
                <div className="space-y-3 py-3">
                  {msgsLoading ? (
                    <div className="flex justify-center py-8">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : messages.length === 0 ? (
                    <p className="text-center text-sm text-muted-foreground py-8">No messages yet</p>
                  ) : (
                    messages.map(m => (
                      <div key={m.id} className={`flex flex-col ${m.sender_type.toUpperCase() === 'SYSTEM' ? 'items-center' : m.sender_type.toUpperCase() === 'SUPPORT' ? 'items-end' : 'items-start'}`}>
                        {m.sender_type.toUpperCase() === 'SYSTEM' ? (
                          <div className="text-xs text-muted-foreground italic bg-muted/50 rounded px-3 py-1.5 max-w-[85%] text-center">
                            {m.message}
                          </div>
                        ) : (
                          <div className={`rounded-lg px-3 py-2 max-w-[85%] ${senderColor(m.sender_type)}`}>
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className="text-xs font-semibold">{senderLabel(m.sender_type)}</span>
                              <span className="text-[10px] opacity-60">{format(new Date(m.created_at), 'HH:mm')}</span>
                            </div>
                            <p className="text-sm whitespace-pre-wrap">{m.message}</p>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                  <div ref={chatEndRef} />
                </div>
              </ScrollArea>

              {/* Message Input */}
              <div className="border-t p-3 shrink-0">
                {isClosed || !lpCase.chat_enabled || chatExpired ? (
                  <p className="text-xs text-muted-foreground text-center py-2">
                    {isClosed ? 'Case is closed' : chatExpired ? 'Chat has expired' : 'Chat is locked'}
                    {' — '}messages are read-only
                  </p>
                ) : (
                  <div className="flex gap-2">
                    <Textarea
                      placeholder="Type support message..."
                      value={msgInput}
                      onChange={e => setMsgInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); }}}
                      rows={2}
                      className="resize-none text-sm"
                    />
                    <Button size="icon" onClick={handleSendMessage} disabled={sending || !msgInput.trim()}>
                      {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* AI Helper */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" /> AI Assistant
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => handleAI('summary')} disabled={!!aiLoading}>
                  {aiLoading === 'summary' ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Bot className="h-3 w-3 mr-1" />}
                  Case Summary
                </Button>
                <Button variant="outline" size="sm" onClick={() => handleAI('reply')} disabled={!!aiLoading}>
                  {aiLoading === 'reply' ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <MessageSquare className="h-3 w-3 mr-1" />}
                  Suggest Reply
                </Button>
                <Button variant="outline" size="sm" onClick={() => handleAI('priority')} disabled={!!aiLoading}>
                  {aiLoading === 'priority' ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <AlertTriangle className="h-3 w-3 mr-1" />}
                  Priority Assessment
                </Button>
              </div>
              {aiResult && (
                <div className="rounded-lg border bg-muted/30 p-3">
                  <p className="text-sm whitespace-pre-wrap">{aiResult}</p>
                  {aiResult && !isClosed && lpCase.chat_enabled && !chatExpired && (
                    <Button variant="ghost" size="sm" className="mt-2" onClick={() => { setMsgInput(aiResult); setAiResult(null); }}>
                      Use as message
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AdminLayout>
  );
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={`text-right truncate ${mono ? 'font-mono text-xs' : ''}`}>{value}</span>
    </div>
  );
}

function PhotoThumbnail({ path, label }: { path: string; label: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    supabase.storage
      .from('lost-property-photos')
      .createSignedUrl(path, 3600)
      .then(({ data }) => {
        if (data?.signedUrl) setUrl(data.signedUrl);
      });
  }, [path]);

  return (
    <div className="relative rounded-md overflow-hidden border bg-muted aspect-square">
      {url ? (
        <img src={url} alt={`${label} photo`} className="object-cover w-full h-full" />
      ) : (
        <div className="flex items-center justify-center h-full">
          <ImageIcon className="h-5 w-5 text-muted-foreground/40" />
        </div>
      )}
      <span className="absolute bottom-0 left-0 right-0 text-[10px] bg-black/50 text-white text-center py-0.5">{label}</span>
    </div>
  );
}
