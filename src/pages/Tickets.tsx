import { useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { 
  Search, 
  Ticket, 
  RefreshCw, 
  Eye, 
  MessageSquare, 
  Clock, 
  CheckCircle,
  MoreVertical,
  User,
  Send,
  Plus,
  Inbox,
  Archive,
  Loader2,
  Car,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface SupportMessage {
  id: string;
  sender_type: string;
  sender_id: string | null;
  content: string;
  created_at: string;
}

interface SupportConversation {
  id: string;
  subject: string;
  status: string;
  priority: string;
  channel: string;
  user_type: string;
  customer_id: string | null;
  driver_id: string | null;
  assigned_admin_id: string | null;
  category: string | null;
  trip_id: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  resolved_at: string | null;
  // Joined data
  customer?: { first_name: string | null; last_name: string | null } | null;
  driver?: { first_name: string; last_name: string; driver_code: string | null } | null;
}

const CATEGORIES = [
  'Payment Issue',
  'App Issue',
  'Account Issue',
  'Document Issue',
  'Trip Issue',
  'Safety Concern',
  'Fare Dispute',
  'General',
];

export default function Tickets() {
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [priorityFilter, setPriorityFilter] = useState<string>('all');
  const [selectedTicket, setSelectedTicket] = useState<SupportConversation | null>(null);
  const [isViewOpen, setIsViewOpen] = useState(false);
  const [newReply, setNewReply] = useState('');
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newTicket, setNewTicket] = useState({
    user_type: 'rider' as string,
    subject: '',
    category: 'General',
    priority: 'normal',
    message: '',
    user_name: '',
  });

  // Fetch conversations
  const { data: tickets = [], isLoading, refetch } = useQuery({
    queryKey: ['support-tickets'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('support_conversations')
        .select(`
          *,
          customer:customers(first_name, last_name),
          driver:drivers(first_name, last_name, driver_code)
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return (data || []) as SupportConversation[];
    },
  });

  // Fetch messages for selected ticket
  const { data: messages = [], isLoading: isLoadingMessages } = useQuery({
    queryKey: ['ticket-messages', selectedTicket?.id],
    queryFn: async () => {
      if (!selectedTicket) return [];
      const { data, error } = await supabase
        .from('support_messages')
        .select('*')
        .eq('conversation_id', selectedTicket.id)
        .order('created_at', { ascending: true });

      if (error) throw error;
      return (data || []) as SupportMessage[];
    },
    enabled: !!selectedTicket,
  });

  // Create ticket mutation
  const createMutation = useMutation({
    mutationFn: async (ticket: typeof newTicket) => {
      // Create conversation
      const { data: conv, error: convError } = await supabase
        .from('support_conversations')
        .insert({
          subject: ticket.subject,
          user_type: ticket.user_type,
          category: ticket.category,
          priority: ticket.priority,
          channel: 'admin',
          initiated_by: 'admin',
        })
        .select()
        .single();

      if (convError) throw convError;

      // Create initial message
      const user = (await supabase.auth.getUser()).data.user;
      const { error: msgError } = await supabase
        .from('support_messages')
        .insert({
          conversation_id: conv.id,
          sender_type: 'admin',
          sender_id: user?.id,
          content: ticket.message,
        });

      if (msgError) throw msgError;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
      toast.success('Ticket created');
      setIsCreateOpen(false);
      setNewTicket({ user_type: 'rider', subject: '', category: 'General', priority: 'normal', message: '', user_name: '' });
    },
    onError: () => toast.error('Failed to create ticket'),
  });

  // Update status mutation
  const updateMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Record<string, any> }) => {
      const { error } = await supabase
        .from('support_conversations')
        .update(updates)
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
      toast.success('Ticket updated');
    },
    onError: () => toast.error('Failed to update ticket'),
  });

  // Send reply mutation
  const replyMutation = useMutation({
    mutationFn: async ({ conversationId, content }: { conversationId: string; content: string }) => {
      const user = (await supabase.auth.getUser()).data.user;
      const { error } = await supabase
        .from('support_messages')
        .insert({
          conversation_id: conversationId,
          sender_type: 'admin',
          sender_id: user?.id,
          content,
        });
      if (error) throw error;

      // Update conversation status if open
      await supabase
        .from('support_conversations')
        .update({
          status: 'waiting',
          assigned_admin_id: user?.id,
        })
        .eq('id', conversationId)
        .in('status', ['open']);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ticket-messages', selectedTicket?.id] });
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
      setNewReply('');
      toast.success('Reply sent');
    },
    onError: () => toast.error('Failed to send reply'),
  });

  const handleStatusChange = (ticketId: string, newStatus: string) => {
    const updates: Record<string, any> = { status: newStatus };
    if (newStatus === 'resolved') updates.resolved_at = new Date().toISOString();
    updateMutation.mutate({ id: ticketId, updates });
  };

  const handleSendReply = () => {
    if (!selectedTicket || !newReply.trim()) return;
    replyMutation.mutate({ conversationId: selectedTicket.id, content: newReply });
  };

  const getUserName = (ticket: SupportConversation) => {
    if (ticket.driver) return `${ticket.driver.first_name} ${ticket.driver.last_name}`;
    if (ticket.customer) return `${ticket.customer.first_name || ''} ${ticket.customer.last_name || ''}`.trim();
    return 'Unknown User';
  };

  const filteredTickets = tickets.filter(ticket => {
    const userName = getUserName(ticket);
    const matchesSearch =
      ticket.subject.toLowerCase().includes(searchTerm.toLowerCase()) ||
      userName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      ticket.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || ticket.status === statusFilter;
    const matchesPriority = priorityFilter === 'all' || ticket.priority === priorityFilter;
    return matchesSearch && matchesStatus && matchesPriority;
  });

  const openCount = tickets.filter(t => t.status === 'open').length;
  const inProgressCount = tickets.filter(t => t.status === 'waiting').length;
  const pendingCount = tickets.filter(t => t.status === 'open' || t.status === 'waiting').length;

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'open':
        return <Badge variant="destructive" className="gap-1"><Inbox className="h-3 w-3" />Open</Badge>;
      case 'waiting':
        return <Badge className="gap-1 bg-yellow-500 hover:bg-yellow-600"><Clock className="h-3 w-3" />Waiting</Badge>;
      case 'resolved':
        return <Badge variant="default" className="gap-1 bg-green-600"><CheckCircle className="h-3 w-3" />Resolved</Badge>;
      case 'closed':
        return <Badge variant="secondary" className="gap-1"><Archive className="h-3 w-3" />Closed</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getPriorityBadge = (priority: string) => {
    switch (priority) {
      case 'urgent':
        return <Badge variant="destructive">Urgent</Badge>;
      case 'high':
        return <Badge className="bg-orange-500 hover:bg-orange-600">High</Badge>;
      case 'normal':
        return <Badge variant="secondary">Normal</Badge>;
      case 'low':
        return <Badge variant="outline">Low</Badge>;
      default:
        return <Badge variant="outline">{priority}</Badge>;
    }
  };

  return (
    <AdminLayout 
      title="Support Tickets" 
      description="Manage customer support tickets"
    >
      <div className="space-y-6">
        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Open Tickets</p>
                  <p className="text-2xl font-bold text-destructive">{openCount}</p>
                </div>
                <Inbox className="h-8 w-8 text-destructive opacity-80" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Waiting Reply</p>
                  <p className="text-2xl font-bold text-yellow-600">{inProgressCount}</p>
                </div>
                <Clock className="h-8 w-8 text-yellow-600 opacity-80" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Active Total</p>
                  <p className="text-2xl font-bold text-blue-600">{pendingCount}</p>
                </div>
                <MessageSquare className="h-8 w-8 text-blue-600 opacity-80" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Tickets</p>
                  <p className="text-2xl font-bold">{tickets.length}</p>
                </div>
                <Ticket className="h-8 w-8 text-primary opacity-80" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Main Content */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Ticket className="h-5 w-5 text-primary" />
                  Ticket Management
                </CardTitle>
                <CardDescription>View and respond to support tickets</CardDescription>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => refetch()} disabled={isLoading}>
                  <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
                  Refresh
                </Button>
                <Button onClick={() => setIsCreateOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  New Ticket
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {/* Filters */}
            <div className="flex flex-col md:flex-row gap-4 mb-6">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search tickets..."
                  className="pl-9"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full md:w-40">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="waiting">Waiting</SelectItem>
                  <SelectItem value="resolved">Resolved</SelectItem>
                  <SelectItem value="closed">Closed</SelectItem>
                </SelectContent>
              </Select>
              <Select value={priorityFilter} onValueChange={setPriorityFilter}>
                <SelectTrigger className="w-full md:w-40">
                  <SelectValue placeholder="Priority" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Priority</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Table */}
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : (
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Subject</TableHead>
                      <TableHead>User</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Priority</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Last Activity</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredTickets.map((ticket) => (
                      <TableRow key={ticket.id} className="cursor-pointer hover:bg-muted/50" onClick={() => {
                        setSelectedTicket(ticket);
                        setIsViewOpen(true);
                      }}>
                        <TableCell className="max-w-[250px] truncate font-medium">
                          {ticket.subject}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {ticket.user_type === 'driver' ? (
                              <Car className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <User className="h-4 w-4 text-muted-foreground" />
                            )}
                            <div>
                              <p className="text-sm">{getUserName(ticket)}</p>
                              <p className="text-xs text-muted-foreground capitalize">{ticket.user_type}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{ticket.category || 'General'}</Badge>
                        </TableCell>
                        <TableCell>{getPriorityBadge(ticket.priority)}</TableCell>
                        <TableCell>{getStatusBadge(ticket.status)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {format(new Date(ticket.last_message_at || ticket.updated_at), 'MMM d, HH:mm')}
                        </TableCell>
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => {
                                setSelectedTicket(ticket);
                                setIsViewOpen(true);
                              }}>
                                <Eye className="h-4 w-4 mr-2" />
                                View & Reply
                              </DropdownMenuItem>
                              {ticket.status !== 'resolved' && ticket.status !== 'closed' && (
                                <DropdownMenuItem onClick={() => handleStatusChange(ticket.id, 'resolved')}>
                                  <CheckCircle className="h-4 w-4 mr-2" />
                                  Mark Resolved
                                </DropdownMenuItem>
                              )}
                              {ticket.status === 'resolved' && (
                                <DropdownMenuItem onClick={() => handleStatusChange(ticket.id, 'closed')}>
                                  <Archive className="h-4 w-4 mr-2" />
                                  Close Ticket
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                    {filteredTickets.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                          {tickets.length === 0 ? 'No tickets yet. Create one to get started.' : 'No tickets match your filters.'}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* View Ticket Dialog */}
      <Dialog open={isViewOpen} onOpenChange={(open) => {
        setIsViewOpen(open);
        if (!open) setSelectedTicket(null);
      }}>
        <DialogContent className="max-w-2xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="truncate">{selectedTicket?.subject}</span>
              {selectedTicket && getStatusBadge(selectedTicket.status)}
            </DialogTitle>
            <DialogDescription>
              {selectedTicket && (
                <span className="flex items-center gap-2">
                  {getUserName(selectedTicket)} · {selectedTicket.user_type} · {selectedTicket.category || 'General'}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          {selectedTicket && (
            <div className="space-y-4">
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  {getPriorityBadge(selectedTicket.priority)}
                  <span className="text-muted-foreground">
                    Created {format(new Date(selectedTicket.created_at), 'PPP p')}
                  </span>
                </div>
              </div>

              <Separator />

              {/* Messages */}
              <ScrollArea className="h-[300px] pr-4">
                {isLoadingMessages ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  </div>
                ) : messages.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">No messages yet.</p>
                ) : (
                  <div className="space-y-4">
                    {messages.map((msg) => (
                      <div
                        key={msg.id}
                        className={`p-4 rounded-lg ${
                          msg.sender_type === 'admin'
                            ? 'bg-primary/10 ml-8'
                            : 'bg-muted mr-8'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="font-medium text-sm capitalize">
                            {msg.sender_type === 'admin' ? 'Support' : selectedTicket.user_type}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {format(new Date(msg.created_at), 'MMM d, HH:mm')}
                          </span>
                        </div>
                        <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>

              <Separator />

              {/* Reply Box */}
              {selectedTicket.status !== 'closed' && (
                <div className="space-y-2">
                  <Label>Reply</Label>
                  <Textarea
                    placeholder="Type your reply..."
                    value={newReply}
                    onChange={(e) => setNewReply(e.target.value)}
                    rows={3}
                  />
                  <div className="flex justify-between">
                    <Select 
                      value={selectedTicket.status} 
                      onValueChange={(v) => handleStatusChange(selectedTicket.id, v)}
                    >
                      <SelectTrigger className="w-40">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="open">Open</SelectItem>
                        <SelectItem value="waiting">Waiting</SelectItem>
                        <SelectItem value="resolved">Resolved</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button onClick={handleSendReply} disabled={!newReply.trim() || replyMutation.isPending}>
                      {replyMutation.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4 mr-2" />
                      )}
                      Send Reply
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Create Ticket Dialog */}
      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New Support Ticket</DialogTitle>
            <DialogDescription>Create a support ticket on behalf of a user.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>User Type</Label>
                <Select value={newTicket.user_type} onValueChange={v => setNewTicket(p => ({ ...p, user_type: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="rider">Rider</SelectItem>
                    <SelectItem value="driver">Driver</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Priority</Label>
                <Select value={newTicket.priority} onValueChange={v => setNewTicket(p => ({ ...p, priority: v }))}>
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
            <div className="space-y-2">
              <Label>Category</Label>
              <Select value={newTicket.category} onValueChange={v => setNewTicket(p => ({ ...p, category: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Subject *</Label>
              <Input value={newTicket.subject} onChange={e => setNewTicket(p => ({ ...p, subject: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>Initial Message *</Label>
              <Textarea rows={4} value={newTicket.message} onChange={e => setNewTicket(p => ({ ...p, message: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateOpen(false)}>Cancel</Button>
            <Button
              onClick={() => createMutation.mutate(newTicket)}
              disabled={!newTicket.subject || !newTicket.message || createMutation.isPending}
            >
              {createMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create Ticket
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
