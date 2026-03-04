import { useState, useCallback } from "react";
import { AdminLayout } from "@/components/layout/AdminLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConversationList } from "@/components/chat/ConversationList";
import { ChatMessageArea } from "@/components/chat/ChatMessageArea";
import { NewConversationDialog } from "@/components/chat/NewConversationDialog";
import { CannedResponsesManager } from "@/components/chat/CannedResponsesManager";
import {
  useSupportConversations,
  useSupportMessages,
  useSendMessage,
  useUpdateConversation,
  useMarkMessagesRead,
  useCannedResponses,
} from "@/hooks/useSupportChat";
import { Plus, Search, MessageSquare, Settings2, RefreshCw } from "lucide-react";

export default function LiveChat() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [isNewOpen, setIsNewOpen] = useState(false);

  const { data: conversations = [], isLoading: convsLoading, refetch } = useSupportConversations(statusFilter);
  const { data: messages = [], isLoading: msgsLoading } = useSupportMessages(selectedConvId);
  const { data: cannedResponses = [] } = useCannedResponses();
  const sendMessage = useSendMessage();
  const updateConv = useUpdateConversation();
  const markRead = useMarkMessagesRead();

  const selectedConv = conversations.find((c) => c.id === selectedConvId) || null;

  const filteredConversations = searchQuery
    ? conversations.filter((c) => {
        const q = searchQuery.toLowerCase();
        const name =
          c.user_type === "customer"
            ? `${c.customer?.first_name || ""} ${c.customer?.last_name || ""}`.toLowerCase()
            : `${c.driver?.first_name || ""} ${c.driver?.last_name || ""}`.toLowerCase();
        return name.includes(q) || c.subject.toLowerCase().includes(q);
      })
    : conversations;

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
      sendMessage.mutate({ conversationId: selectedConvId, content });
    },
    [selectedConvId, sendMessage]
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

  const openCount = conversations.filter((c) => c.status === "open").length;
  const waitingCount = conversations.filter((c) => c.status === "waiting").length;
  const totalUnread = conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);

  return (
    <AdminLayout title="Live Chat" description="Real-time support conversations with customers and drivers">
      <Tabs defaultValue="chat" className="space-y-4">
        <div className="flex items-center justify-between">
          <TabsList>
            <TabsTrigger value="chat" className="gap-2">
              <MessageSquare className="h-4 w-4" />
              Conversations
              {totalUnread > 0 && (
                <span className="ml-1 h-5 min-w-5 flex items-center justify-center rounded-full bg-primary text-primary-foreground text-xs">
                  {totalUnread}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="settings" className="gap-2">
              <Settings2 className="h-4 w-4" />
              Quick Replies
            </TabsTrigger>
          </TabsList>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={convsLoading}>
              <RefreshCw className={`h-4 w-4 mr-1 ${convsLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button size="sm" onClick={() => setIsNewOpen(true)}>
              <Plus className="h-4 w-4 mr-1" />
              New Conversation
            </Button>
          </div>
        </div>

        <TabsContent value="chat" className="mt-0">
          <div className="border rounded-lg flex h-[calc(100vh-220px)] overflow-hidden bg-background">
            {/* Left sidebar */}
            <div className="w-80 border-r flex flex-col shrink-0">
              {/* Search + filters */}
              <div className="p-3 border-b space-y-2 shrink-0">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search conversations..."
                    className="pl-9 h-9"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
                <div className="flex gap-1 flex-wrap">
                  {[
                    { label: "All", value: "all" },
                    { label: `Open (${openCount})`, value: "open" },
                    { label: `Waiting (${waitingCount})`, value: "waiting" },
                    { label: "Resolved", value: "resolved" },
                  ].map((f) => (
                    <Button
                      key={f.value}
                      variant={statusFilter === f.value ? "default" : "outline"}
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setStatusFilter(f.value)}
                    >
                      {f.label}
                    </Button>
                  ))}
                </div>
              </div>
              {/* Conversation list */}
              <div className="flex-1 overflow-hidden">
                <ConversationList
                  conversations={filteredConversations}
                  selectedId={selectedConvId}
                  onSelect={handleSelectConv}
                />
              </div>
            </div>

            {/* Right chat area */}
            <div className="flex-1 min-w-0">
              <ChatMessageArea
                conversation={selectedConv}
                messages={messages}
                isLoading={msgsLoading}
                isSending={sendMessage.isPending}
                cannedResponses={cannedResponses}
                onSend={handleSend}
                onStatusChange={handleStatusChange}
                onPriorityChange={handlePriorityChange}
              />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="settings" className="mt-0">
          <div className="max-w-2xl">
            <CannedResponsesManager />
          </div>
        </TabsContent>
      </Tabs>

      <NewConversationDialog
        open={isNewOpen}
        onOpenChange={setIsNewOpen}
        onCreated={(id) => {
          setSelectedConvId(id);
          refetch();
        }}
      />
    </AdminLayout>
  );
}
