import { useRef, useEffect, useState, memo } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Send,
  Loader2,
  Zap,
  CheckCircle,
  Clock,
  XCircle,
  User,
  Car,
  Shield,
  Bot,
} from "lucide-react";
import { format } from "date-fns";
import type { SupportMessage, SupportConversation, CannedResponse } from "@/hooks/useSupportChat";

interface Props {
  conversation: SupportConversation | null;
  messages: SupportMessage[];
  isLoading: boolean;
  isSending: boolean;
  cannedResponses: CannedResponse[];
  onSend: (content: string) => void;
  onStatusChange: (status: string) => void;
  onPriorityChange: (priority: string) => void;
}

const senderIcons: Record<string, React.ReactNode> = {
  admin: <Shield className="h-3.5 w-3.5" />,
  customer: <User className="h-3.5 w-3.5" />,
  driver: <Car className="h-3.5 w-3.5" />,
  system: <Bot className="h-3.5 w-3.5" />,
};

const senderColors: Record<string, string> = {
  admin: "bg-primary text-primary-foreground",
  customer: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  driver: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  system: "bg-muted text-muted-foreground",
};

export const ChatMessageArea = memo(function ChatMessageArea({
  conversation,
  messages,
  isLoading,
  isSending,
  cannedResponses,
  onSend,
  onStatusChange,
  onPriorityChange,
}: Props) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = () => {
    if (!draft.trim() || isSending) return;
    onSend(draft.trim());
    setDraft("");
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const insertCanned = (content: string) => {
    setDraft((prev) => (prev ? prev + "\n" + content : content));
    textareaRef.current?.focus();
  };

  if (!conversation) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <Send className="h-12 w-12 mb-4 opacity-30" />
        <p className="text-lg font-medium">Select a conversation</p>
        <p className="text-sm">Choose a conversation from the left to start chatting</p>
      </div>
    );
  }

  const getUserName = () => {
    if (conversation.user_type === "customer" && conversation.customer) {
      return [conversation.customer.first_name, conversation.customer.last_name].filter(Boolean).join(" ") || "Customer";
    }
    if (conversation.user_type === "driver" && conversation.driver) {
      return `${conversation.driver.first_name} ${conversation.driver.last_name}`.trim();
    }
    return "User";
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3 shrink-0">
        <div className="flex items-center gap-3">
          <div className={cn(
            "flex h-9 w-9 items-center justify-center rounded-full",
            conversation.user_type === "driver" ? "bg-blue-100 text-blue-600" : "bg-green-100 text-green-600"
          )}>
            {conversation.user_type === "driver" ? <Car className="h-4 w-4" /> : <User className="h-4 w-4" />}
          </div>
          <div>
            <h3 className="font-semibold text-sm">{getUserName()}</h3>
            <p className="text-xs text-muted-foreground">{conversation.subject}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Select value={conversation.priority} onValueChange={onPriorityChange}>
            <SelectTrigger className="w-28 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="normal">Normal</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="urgent">Urgent</SelectItem>
            </SelectContent>
          </Select>
          <Select value={conversation.status} onValueChange={onStatusChange}>
            <SelectTrigger className="w-28 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="waiting">Waiting</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
              <SelectItem value="closed">Closed</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : messages.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-8">No messages yet</p>
        ) : (
          messages.map((msg) => {
            const isAdmin = msg.sender_type === "admin";
            const isSystem = msg.sender_type === "system";

            if (isSystem) {
              return (
                <div key={msg.id} className="flex justify-center">
                  <div className="bg-muted px-3 py-1.5 rounded-full text-xs text-muted-foreground flex items-center gap-1.5">
                    <Bot className="h-3 w-3" />
                    {msg.content}
                  </div>
                </div>
              );
            }

            return (
              <div key={msg.id} className={cn("flex", isAdmin ? "justify-end" : "justify-start")}>
                <div className={cn("max-w-[75%] space-y-1")}>
                  <div className={cn(
                    "rounded-2xl px-4 py-2.5 text-sm",
                    isAdmin
                      ? "bg-primary text-primary-foreground rounded-br-md"
                      : "bg-muted rounded-bl-md"
                  )}>
                    {msg.content}
                  </div>
                  <div className={cn("flex items-center gap-1.5 text-[10px] text-muted-foreground", isAdmin && "justify-end")}>
                    {senderIcons[msg.sender_type]}
                    <span className="capitalize">{msg.sender_type}</span>
                    <span>·</span>
                    <span>{format(new Date(msg.created_at), "HH:mm")}</span>
                    {isAdmin && msg.is_read && (
                      <>
                        <span>·</span>
                        <CheckCircle className="h-3 w-3 text-green-500" />
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Input */}
      <div className="border-t p-3 shrink-0">
        <div className="flex items-end gap-2">
          {cannedResponses.length > 0 && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="icon" className="shrink-0 h-10 w-10">
                  <Zap className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-72 p-0" align="start">
                <div className="p-2 border-b">
                  <p className="text-xs font-medium text-muted-foreground">Quick Replies</p>
                </div>
                <ScrollArea className="max-h-48">
                  <div className="p-1">
                    {cannedResponses.map((cr) => (
                      <button
                        key={cr.id}
                        onClick={() => insertCanned(cr.content)}
                        className="w-full text-left px-3 py-2 rounded-md text-sm hover:bg-accent transition-colors"
                      >
                        <p className="font-medium text-xs">{cr.title}</p>
                        <p className="text-xs text-muted-foreground truncate">{cr.content}</p>
                      </button>
                    ))}
                  </div>
                </ScrollArea>
              </PopoverContent>
            </Popover>
          )}
          <Textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
            className="min-h-[40px] max-h-[120px] resize-none"
            rows={1}
          />
          <Button onClick={handleSend} disabled={!draft.trim() || isSending} className="shrink-0 h-10">
            {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
});
