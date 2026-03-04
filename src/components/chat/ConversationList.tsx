import { memo } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatDistanceToNow } from "date-fns";
import { User, Car, MessageSquare } from "lucide-react";
import type { SupportConversation } from "@/hooks/useSupportChat";

interface Props {
  conversations: SupportConversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const statusColors: Record<string, string> = {
  open: "bg-red-500",
  waiting: "bg-yellow-500",
  resolved: "bg-green-500",
  closed: "bg-muted-foreground",
};

const priorityColors: Record<string, string> = {
  urgent: "text-red-500",
  high: "text-orange-500",
  normal: "text-muted-foreground",
  low: "text-muted-foreground/60",
};

function getUserName(conv: SupportConversation) {
  if (conv.user_type === "customer" && conv.customer) {
    const name = [conv.customer.first_name, conv.customer.last_name].filter(Boolean).join(" ");
    return name || conv.customer.phone || "Customer";
  }
  if (conv.user_type === "driver" && conv.driver) {
    return `${conv.driver.first_name} ${conv.driver.last_name}`.trim() || conv.driver.email;
  }
  return conv.user_type === "customer" ? "Customer" : "Driver";
}

export const ConversationList = memo(function ConversationList({ conversations, selectedId, onSelect }: Props) {
  if (conversations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <MessageSquare className="h-10 w-10 mb-3 opacity-40" />
        <p className="text-sm">No conversations yet</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="space-y-0.5 p-2">
        {conversations.map((conv) => (
          <button
            key={conv.id}
            onClick={() => onSelect(conv.id)}
            className={cn(
              "w-full text-left rounded-lg p-3 transition-colors hover:bg-accent",
              selectedId === conv.id && "bg-accent"
            )}
          >
            <div className="flex items-start gap-3">
              <div className={cn(
                "mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                conv.user_type === "driver" ? "bg-blue-100 text-blue-600" : "bg-green-100 text-green-600"
              )}>
                {conv.user_type === "driver" ? <Car className="h-4 w-4" /> : <User className="h-4 w-4" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium truncate">{getUserName(conv)}</span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatDistanceToNow(new Date(conv.last_message_at), { addSuffix: true })}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground truncate">{conv.subject}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className={cn("h-2 w-2 rounded-full", statusColors[conv.status] || "bg-muted")} />
                  <span className="text-xs capitalize text-muted-foreground">{conv.status}</span>
                  {conv.priority !== "normal" && (
                    <span className={cn("text-xs font-medium capitalize", priorityColors[conv.priority])}>
                      {conv.priority}
                    </span>
                  )}
                  {(conv.unread_count || 0) > 0 && (
                    <Badge className="ml-auto h-5 min-w-5 flex items-center justify-center text-xs bg-primary text-primary-foreground">
                      {conv.unread_count}
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          </button>
        ))}
      </div>
    </ScrollArea>
  );
});
