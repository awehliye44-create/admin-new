import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (conversationId: string) => void;
}

export function NewConversationDialog({ open, onOpenChange, onCreated }: Props) {
  const [userType, setUserType] = useState<"customer" | "driver">("customer");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [selectedUser, setSelectedUser] = useState<any>(null);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [priority, setPriority] = useState("normal");
  const [category, setCategory] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      if (userType === "customer") {
        const { data } = await supabase
          .from("customers")
          .select("id, first_name, last_name, phone")
          .or(`first_name.ilike.%${searchQuery}%,last_name.ilike.%${searchQuery}%,phone.ilike.%${searchQuery}%`)
          .limit(10);
        setSearchResults(data || []);
      } else {
        const { data } = await supabase
          .from("drivers")
          .select("id, first_name, last_name, email, phone")
          .or(`first_name.ilike.%${searchQuery}%,last_name.ilike.%${searchQuery}%,email.ilike.%${searchQuery}%`)
          .limit(10);
        setSearchResults(data || []);
      }
    } finally {
      setIsSearching(false);
    }
  };

  const handleCreate = async () => {
    if (!selectedUser || !subject.trim() || !message.trim()) {
      toast.error("Please fill in all required fields");
      return;
    }
    setIsCreating(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data: conv, error: convError } = await supabase
        .from("support_conversations")
        .insert({
          subject,
          user_type: userType,
          customer_id: userType === "customer" ? selectedUser.id : null,
          driver_id: userType === "driver" ? selectedUser.id : null,
          initiated_by: "admin",
          assigned_admin_id: user.id,
          priority,
          category: category || null,
        })
        .select()
        .single();

      if (convError) throw convError;

      await supabase.from("support_messages").insert({
        conversation_id: conv.id,
        sender_type: "admin",
        sender_id: user.id,
        content: message,
      });

      onCreated(conv.id);
      onOpenChange(false);
      resetForm();
      toast.success("Conversation created");
    } catch (err: any) {
      toast.error(err.message || "Failed to create conversation");
    } finally {
      setIsCreating(false);
    }
  };

  const resetForm = () => {
    setSearchQuery("");
    setSearchResults([]);
    setSelectedUser(null);
    setSubject("");
    setMessage("");
    setPriority("normal");
    setCategory("");
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) resetForm(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New Conversation</DialogTitle>
          <DialogDescription>Start a new support conversation with a customer or driver</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>User Type</Label>
              <Select value={userType} onValueChange={(v: "customer" | "driver") => { setUserType(v); setSelectedUser(null); setSearchResults([]); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="customer">Customer</SelectItem>
                  <SelectItem value="driver">Driver</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Priority</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* User search */}
          <div>
            <Label>Find {userType}</Label>
            <div className="flex gap-2 mt-1">
              <Input
                placeholder={`Search by name${userType === "driver" ? " or email" : " or phone"}...`}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              />
              <Button variant="outline" onClick={handleSearch} disabled={isSearching}>
                {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : "Search"}
              </Button>
            </div>
            {searchResults.length > 0 && !selectedUser && (
              <div className="mt-2 border rounded-md max-h-36 overflow-y-auto">
                {searchResults.map((u) => (
                  <button
                    key={u.id}
                    className="w-full text-left px-3 py-2 hover:bg-accent text-sm border-b last:border-0"
                    onClick={() => setSelectedUser(u)}
                  >
                    {u.first_name} {u.last_name}
                    {u.email && <span className="text-muted-foreground ml-2">{u.email}</span>}
                    {u.phone && <span className="text-muted-foreground ml-2">{u.phone}</span>}
                  </button>
                ))}
              </div>
            )}
            {selectedUser && (
              <div className="mt-2 flex items-center gap-2 bg-accent rounded-md px-3 py-2 text-sm">
                <span className="font-medium">{selectedUser.first_name} {selectedUser.last_name}</span>
                <Button variant="ghost" size="sm" className="ml-auto h-6 text-xs" onClick={() => setSelectedUser(null)}>Change</Button>
              </div>
            )}
          </div>

          <div>
            <Label>Category (optional)</Label>
            <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Payment Issue, App Bug" />
          </div>

          <div>
            <Label>Subject *</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Brief description of the issue" />
          </div>

          <div>
            <Label>Initial Message *</Label>
            <Textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Type your message..." rows={3} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleCreate} disabled={isCreating || !selectedUser || !subject.trim() || !message.trim()}>
            {isCreating ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Create & Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
