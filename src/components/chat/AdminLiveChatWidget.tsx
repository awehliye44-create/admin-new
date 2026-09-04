import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { MessageSquare, X, ArrowLeft, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConversationList } from "@/components/chat/ConversationList";
import { ChatMessageArea } from "@/components/chat/ChatMessageArea";
import {
  useSupportConversations,
  useSupportMessages,
  useSendMessage,
  useUpdateConversation,
  useMarkMessagesRead,
  useCannedResponses,
  useResolveWhatsAppConversation,
} from "@/hooks/useSupportChat";
import { useAuth } from "@/hooks/useAuth";
import { ADMIN_SUPPORT_INBOX_PAGE_SIZE } from "@/lib/adminQueryBounds";

/**
 * Floating Live Chat widget for the Admin Panel.
 * Rendered inside AdminShell (already behind ProtectedRoute) and additionally
 * gated on an authenticated admin user, so it is only visible when signed in.
 * Anchored bottom-left; opens a compact inbox + chat panel backed by the same
 * support conversation SSOT as the Admin → Live Chat page.
 */
export function AdminLiveChatWidget() {
  const { user, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);

  const { data: conversations = [] } = useSupportConversations("all", ADMIN_SUPPORT_INBOX_PAGE_SIZE);
  const { data: messages = [], isLoading: msgsLoading } = useSupportMessages(selectedConvId);
  const { data: cannedResponses = [] } = useCannedResponses();
  const sendMessage = useSendMessage();
  const updateConv = useUpdateConversation();
  const markRead = useMarkMessagesRead();
  const resolveWhatsApp = useResolveWhatsAppConversation();

  const selectedConv = conversations.find((c) => c.id === selectedConvId) || null;
  const totalUnread = conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);

  // Clear selection if the conversation falls out of the current inbox window.
  const prevConvsRef = useRef(conversations);
  useEffect(() => {
    if (prevConvsRef.current !== conversations && selectedConvId && !conversations.some((c) => c.id === selectedConvId)) {
      setSelectedConvId(null);
    }
    prevConvsRef.current = conversations;
  }, [conversations, selectedConvId]);

  const handleSelectConv = useCallback(
    (id: string) => {
      setSelectedConvId(id);
      markRead.mutate(id);
    },
    [markRead]
  );

  const handleSend = useCallback(
    (content: string) => {
      if (!selectedConvId) return;
      sendMessage.mutate({ conversationId: selectedConvId, content, channel: selectedConv?.channel });
    },
    [selectedConvId, selectedConv, sendMessage]
  );

  const handleStatusChange = useCallback(
    (status: string) => {
      if (!selectedConvId) return;
      updateConv.mutate({
        id: selectedConvId,
        status,
        resolved_at: status === "resolved" ? new Date().toISOString() : null,
      });
    },
    [selectedConvId, updateConv]
  );

  const handlePriorityChange = useCallback(
    (priority: string) => {
      if (!selectedConvId) return;
      updateConv.mutate({ id: selectedConvId, priority });
    },
    [selectedConvId, updateConv]
  );

  const handleWhatsAppResolve = useCallback(() => {
    if (!selectedConvId) return;
    resolveWhatsApp.mutate(selectedConvId);
  }, [selectedConvId, resolveWhatsApp]);

  // Only visible when an admin is signed in.
  if (!user || !isAdmin) return null;

  return (
    <>
      {isOpen && (
        <div
          className="fixed bottom-20 left-4 z-50 flex h-[70vh] max-h-[640px] w-[min(92vw,420px)] flex-col overflow-hidden rounded-lg border bg-background shadow-2xl"
          role="dialog"
          aria-label="Live Chat widget"
        >
          <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
            <div className="flex items-center gap-2 min-w-0">
              {selectedConv && (
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setSelectedConvId(null)} aria-label="Back to conversations">
                  <ArrowLeft className="h-4 w-4" />
                </Button>
              )}
              <span className="truncate text-sm font-semibold">
                {selectedConv ? selectedConv.subject : "Live Chat"}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label="Open full Live Chat page"
                onClick={() => {
                  setIsOpen(false);
                  navigate("/live-chat");
                }}
              >
                <ExternalLink className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Close Live Chat" onClick={() => setIsOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            {selectedConv ? (
              <ChatMessageArea
                conversation={selectedConv}
                messages={messages}
                isLoading={msgsLoading}
                isSending={sendMessage.isPending}
                isResolving={resolveWhatsApp.isPending}
                cannedResponses={cannedResponses}
                onSend={handleSend}
                onStatusChange={handleStatusChange}
                onPriorityChange={handlePriorityChange}
                onWhatsAppResolve={selectedConv.channel === "whatsapp" ? handleWhatsAppResolve : undefined}
              />
            ) : (
              <div className="min-h-0 flex-1 overflow-hidden">
                <ConversationList
                  conversations={conversations}
                  selectedId={selectedConvId}
                  onSelect={handleSelectConv}
                />
              </div>
            )}
          </div>
        </div>
      )}

      <Button
        size="icon"
        className="fixed bottom-4 left-4 z-50 h-12 w-12 rounded-full shadow-lg"
        aria-label={isOpen ? "Close Live Chat" : "Open Live Chat"}
        onClick={() => setIsOpen((v) => !v)}
      >
        {isOpen ? <X className="h-5 w-5" /> : <MessageSquare className="h-5 w-5" />}
        {!isOpen && totalUnread > 0 && (
          <span className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-xs font-bold text-destructive-foreground">
            {totalUnread > 99 ? "99+" : totalUnread}
          </span>
        )}
      </Button>
    </>
  );
}
