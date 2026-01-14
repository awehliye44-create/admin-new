import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDriverInboxMessages, useDeleteInboxMessage, DriverInboxMessage } from "@/hooks/useDriverInbox";
import {
  Inbox,
  Search,
  Loader2,
  MoreHorizontal,
  Eye,
  Trash2,
  Mail,
  MailOpen,
  Bell,
  Calendar,
  RefreshCw,
} from "lucide-react";
import { format } from "date-fns";

export function DriverInboxAdmin() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedMessage, setSelectedMessage] = useState<DriverInboxMessage | null>(null);
  const [isViewOpen, setIsViewOpen] = useState(false);

  const { data: messages, isLoading, refetch } = useDriverInboxMessages();
  const deleteMessage = useDeleteInboxMessage();

  const filteredMessages = messages?.filter((msg) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      msg.title.toLowerCase().includes(query) ||
      msg.body.toLowerCase().includes(query) ||
      msg.driver?.first_name?.toLowerCase().includes(query) ||
      msg.driver?.last_name?.toLowerCase().includes(query)
    );
  });

  const getTypeIcon = (type: string) => {
    switch (type) {
      case "DOCUMENT_REMINDER":
        return <Calendar className="h-4 w-4 text-orange-500" />;
      default:
        return <Bell className="h-4 w-4 text-blue-500" />;
    }
  };

  const getTypeBadge = (type: string) => {
    switch (type) {
      case "DOCUMENT_REMINDER":
        return (
          <Badge variant="outline" className="bg-orange-100 text-orange-700">
            Document Reminder
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="bg-blue-100 text-blue-700">
            General
          </Badge>
        );
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Inbox className="h-5 w-5 text-primary" />
              Driver Inbox Messages
            </CardTitle>
            <CardDescription>
              View and manage notifications sent to driver inboxes
            </CardDescription>
          </div>
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search messages..."
                className="pl-9 w-full md:w-[200px]"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <Button variant="outline" onClick={() => refetch()} disabled={isLoading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : filteredMessages?.length === 0 ? (
            <div className="py-12 text-center">
              <Inbox className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No messages</h3>
              <p className="text-muted-foreground">
                {searchQuery
                  ? "No messages match your search"
                  : "No inbox messages have been sent yet"}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredMessages?.map((message) => (
                  <TableRow key={message.id}>
                    <TableCell>
                      {message.is_read ? (
                        <MailOpen className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <Mail className="h-4 w-4 text-primary" />
                      )}
                    </TableCell>
                    <TableCell>{getTypeBadge(message.type)}</TableCell>
                    <TableCell>
                      <div>
                        <p className="font-medium">
                          {message.driver?.first_name} {message.driver?.last_name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {message.driver?.email}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {getTypeIcon(message.type)}
                        <span className="truncate max-w-[200px]">{message.title}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {format(new Date(message.created_at), "MMM d, yyyy HH:mm")}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => {
                              setSelectedMessage(message);
                              setIsViewOpen(true);
                            }}
                          >
                            <Eye className="h-4 w-4 mr-2" />
                            View Message
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-red-600"
                            onClick={() => {
                              if (confirm("Delete this message?")) {
                                deleteMessage.mutate(message.id);
                              }
                            }}
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* View Message Dialog */}
      <Dialog open={isViewOpen} onOpenChange={setIsViewOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Message Details</DialogTitle>
            <DialogDescription>
              Sent to {selectedMessage?.driver?.first_name} {selectedMessage?.driver?.last_name}
            </DialogDescription>
          </DialogHeader>
          {selectedMessage && (
            <div className="space-y-4">
              <div>
                <p className="text-sm text-muted-foreground">Type</p>
                {getTypeBadge(selectedMessage.type)}
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Title</p>
                <p className="font-medium">{selectedMessage.title}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Message</p>
                <p className="text-sm bg-muted p-3 rounded-md">{selectedMessage.body}</p>
              </div>
              {selectedMessage.expiry_date && (
                <div>
                  <p className="text-sm text-muted-foreground">Document Expiry</p>
                  <p className="font-medium">
                    {format(new Date(selectedMessage.expiry_date), "PPP")}
                  </p>
                </div>
              )}
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <div>
                  Sent: {format(new Date(selectedMessage.created_at), "PPP p")}
                </div>
                <div>
                  Status: {selectedMessage.is_read ? "Read" : "Unread"}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setIsViewOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
