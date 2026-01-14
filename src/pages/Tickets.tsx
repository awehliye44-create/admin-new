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
  AlertCircle,
  Archive
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

interface TicketMessage {
  id: string;
  sender: 'user' | 'support';
  sender_name: string;
  message: string;
  created_at: string;
}

interface SupportTicket {
  id: string;
  ticket_number: string;
  user_type: 'rider' | 'driver';
  user_name: string;
  user_email: string;
  category: string;
  subject: string;
  status: 'open' | 'pending' | 'in_progress' | 'resolved' | 'closed';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  created_at: string;
  updated_at: string;
  assigned_to: string | null;
  messages: TicketMessage[];
}

const defaultTickets: SupportTicket[] = [
  {
    id: '1',
    ticket_number: 'TKT-2024-0001',
    user_type: 'rider',
    user_name: 'John Smith',
    user_email: 'john.s@email.com',
    category: 'Payment Issue',
    subject: 'Double charged for my last trip',
    status: 'open',
    priority: 'high',
    created_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    assigned_to: null,
    messages: [
      {
        id: 'm1',
        sender: 'user',
        sender_name: 'John Smith',
        message: 'I was charged twice for my trip yesterday. Trip ID: TRIP-12345. Please refund the duplicate charge.',
        created_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      },
    ],
  },
  {
    id: '2',
    ticket_number: 'TKT-2024-0002',
    user_type: 'driver',
    user_name: 'Michael Brown',
    user_email: 'michael.b@email.com',
    category: 'App Issue',
    subject: 'App crashes when accepting rides',
    status: 'in_progress',
    priority: 'urgent',
    created_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    assigned_to: 'Tech Support',
    messages: [
      {
        id: 'm2',
        sender: 'user',
        sender_name: 'Michael Brown',
        message: 'The app keeps crashing every time I try to accept a ride. I\'m using iPhone 14 with iOS 17.',
        created_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: 'm3',
        sender: 'support',
        sender_name: 'Tech Support',
        message: 'Thank you for reporting this issue. We are investigating. Can you please try clearing the app cache and restarting?',
        created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      },
    ],
  },
  {
    id: '3',
    ticket_number: 'TKT-2024-0003',
    user_type: 'rider',
    user_name: 'Emily Davis',
    user_email: 'emily.d@email.com',
    category: 'Account Issue',
    subject: 'Cannot update my phone number',
    status: 'pending',
    priority: 'normal',
    created_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
    assigned_to: 'Support Agent 1',
    messages: [
      {
        id: 'm4',
        sender: 'user',
        sender_name: 'Emily Davis',
        message: 'I need to update my phone number but the app says it\'s already in use by another account.',
        created_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: 'm5',
        sender: 'support',
        sender_name: 'Support Agent 1',
        message: 'I understand your concern. Can you please provide the new phone number you\'re trying to add?',
        created_at: new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString(),
      },
    ],
  },
  {
    id: '4',
    ticket_number: 'TKT-2024-0004',
    user_type: 'driver',
    user_name: 'Sarah Johnson',
    user_email: 'sarah.j@email.com',
    category: 'Document Issue',
    subject: 'Document verification pending too long',
    status: 'resolved',
    priority: 'normal',
    created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    assigned_to: 'Document Team',
    messages: [
      {
        id: 'm6',
        sender: 'user',
        sender_name: 'Sarah Johnson',
        message: 'My documents have been pending verification for over 5 days. Please expedite.',
        created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: 'm7',
        sender: 'support',
        sender_name: 'Document Team',
        message: 'Your documents have been verified and approved. You can now start accepting rides.',
        created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ],
  },
];

export default function Tickets() {
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [priorityFilter, setPriorityFilter] = useState<string>('all');
  const [selectedTicket, setSelectedTicket] = useState<SupportTicket | null>(null);
  const [isViewOpen, setIsViewOpen] = useState(false);
  const [newReply, setNewReply] = useState('');

  const { data: tickets = defaultTickets, isLoading, refetch } = useQuery({
    queryKey: ['support-tickets'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('*')
        .eq('setting_key', 'support_tickets')
        .single();

      if (error || !data) return defaultTickets;
      return (data.setting_value as unknown as SupportTicket[]) || defaultTickets;
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (updatedTickets: SupportTicket[]) => {
      const { error } = await supabase
        .from('admin_settings')
        .upsert({
          setting_key: 'support_tickets',
          setting_value: updatedTickets as any,
          description: 'Support tickets data',
        } as any, { onConflict: 'setting_key' });

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
      toast.success('Ticket updated successfully');
    },
    onError: () => {
      toast.error('Failed to update ticket');
    },
  });

  const handleStatusChange = (ticketId: string, newStatus: SupportTicket['status']) => {
    const updated = tickets.map(t => 
      t.id === ticketId 
        ? { ...t, status: newStatus, updated_at: new Date().toISOString() }
        : t
    );
    saveMutation.mutate(updated);
    
    if (selectedTicket?.id === ticketId) {
      setSelectedTicket({ ...selectedTicket, status: newStatus });
    }
  };

  const handleSendReply = () => {
    if (!selectedTicket || !newReply.trim()) {
      toast.error('Please enter a message');
      return;
    }

    const newMessage: TicketMessage = {
      id: `m-${Date.now()}`,
      sender: 'support',
      sender_name: 'Support Agent',
      message: newReply,
      created_at: new Date().toISOString(),
    };

    const updated = tickets.map(t => 
      t.id === selectedTicket.id 
        ? { 
            ...t, 
            messages: [...t.messages, newMessage],
            status: t.status === 'open' ? 'in_progress' as const : t.status,
            updated_at: new Date().toISOString(),
            assigned_to: t.assigned_to || 'Support Agent',
          }
        : t
    );

    saveMutation.mutate(updated);
    setSelectedTicket({
      ...selectedTicket,
      messages: [...selectedTicket.messages, newMessage],
      status: selectedTicket.status === 'open' ? 'in_progress' : selectedTicket.status,
    });
    setNewReply('');
  };

  const filteredTickets = tickets.filter(ticket => {
    const matchesSearch = 
      ticket.ticket_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
      ticket.subject.toLowerCase().includes(searchTerm.toLowerCase()) ||
      ticket.user_name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || ticket.status === statusFilter;
    const matchesPriority = priorityFilter === 'all' || ticket.priority === priorityFilter;
    return matchesSearch && matchesStatus && matchesPriority;
  });

  const openCount = tickets.filter(t => t.status === 'open').length;
  const inProgressCount = tickets.filter(t => t.status === 'in_progress').length;
  const pendingCount = tickets.filter(t => t.status === 'pending').length;

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'open':
        return <Badge variant="destructive" className="gap-1"><Inbox className="h-3 w-3" />Open</Badge>;
      case 'pending':
        return <Badge className="gap-1 bg-yellow-500 hover:bg-yellow-600"><Clock className="h-3 w-3" />Pending</Badge>;
      case 'in_progress':
        return <Badge className="gap-1 bg-blue-500 hover:bg-blue-600"><MessageSquare className="h-3 w-3" />In Progress</Badge>;
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
                  <p className="text-sm text-muted-foreground">In Progress</p>
                  <p className="text-2xl font-bold text-blue-600">{inProgressCount}</p>
                </div>
                <MessageSquare className="h-8 w-8 text-blue-600 opacity-80" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Pending Reply</p>
                  <p className="text-2xl font-bold text-yellow-600">{pendingCount}</p>
                </div>
                <Clock className="h-8 w-8 text-yellow-600 opacity-80" />
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
              <Button variant="outline" onClick={() => refetch()} disabled={isLoading}>
                <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
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
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="in_progress">In Progress</SelectItem>
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
            <div className="border rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ticket #</TableHead>
                    <TableHead>Subject</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTickets.map((ticket) => (
                    <TableRow key={ticket.id} className="cursor-pointer hover:bg-muted/50" onClick={() => {
                      setSelectedTicket(ticket);
                      setIsViewOpen(true);
                    }}>
                      <TableCell className="font-mono text-sm">{ticket.ticket_number}</TableCell>
                      <TableCell className="max-w-[200px] truncate font-medium">
                        {ticket.subject}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <User className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <p className="text-sm">{ticket.user_name}</p>
                            <p className="text-xs text-muted-foreground capitalize">{ticket.user_type}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{ticket.category}</Badge>
                      </TableCell>
                      <TableCell>{getPriorityBadge(ticket.priority)}</TableCell>
                      <TableCell>{getStatusBadge(ticket.status)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {format(new Date(ticket.updated_at), 'MMM d, HH:mm')}
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
                      <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                        No tickets found
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* View Ticket Dialog */}
      <Dialog open={isViewOpen} onOpenChange={setIsViewOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span>{selectedTicket?.ticket_number}</span>
              {selectedTicket && getStatusBadge(selectedTicket.status)}
            </DialogTitle>
            <DialogDescription>{selectedTicket?.subject}</DialogDescription>
          </DialogHeader>
          {selectedTicket && (
            <div className="space-y-4">
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-4">
                  <div>
                    <span className="text-muted-foreground">From: </span>
                    <span className="font-medium">{selectedTicket.user_name}</span>
                    <span className="text-muted-foreground"> ({selectedTicket.user_email})</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {getPriorityBadge(selectedTicket.priority)}
                  <Badge variant="outline">{selectedTicket.category}</Badge>
                </div>
              </div>

              <Separator />

              {/* Messages */}
              <ScrollArea className="h-[300px] pr-4">
                <div className="space-y-4">
                  {selectedTicket.messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`p-4 rounded-lg ${
                        msg.sender === 'support'
                          ? 'bg-primary/10 ml-8'
                          : 'bg-muted mr-8'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-medium text-sm">{msg.sender_name}</span>
                        <span className="text-xs text-muted-foreground">
                          {format(new Date(msg.created_at), 'MMM d, HH:mm')}
                        </span>
                      </div>
                      <p className="text-sm whitespace-pre-wrap">{msg.message}</p>
                    </div>
                  ))}
                </div>
              </ScrollArea>

              <Separator />

              {/* Reply Box */}
              {selectedTicket.status !== 'closed' && (
                <div className="space-y-2">
                  <Label>Reply</Label>
                  <div className="flex gap-2">
                    <Textarea
                      placeholder="Type your reply..."
                      value={newReply}
                      onChange={(e) => setNewReply(e.target.value)}
                      className="flex-1"
                      rows={3}
                    />
                  </div>
                  <div className="flex justify-between">
                    <Select 
                      value={selectedTicket.status} 
                      onValueChange={(v) => handleStatusChange(selectedTicket.id, v as SupportTicket['status'])}
                    >
                      <SelectTrigger className="w-40">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="open">Open</SelectItem>
                        <SelectItem value="pending">Pending</SelectItem>
                        <SelectItem value="in_progress">In Progress</SelectItem>
                        <SelectItem value="resolved">Resolved</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button onClick={handleSendReply} disabled={!newReply.trim()}>
                      <Send className="h-4 w-4 mr-2" />
                      Send Reply
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
