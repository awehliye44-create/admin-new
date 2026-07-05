import React, { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRegions } from '@/hooks/useRegions';
import { useServiceAreas } from '@/hooks/useServiceAreas';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import { 
  Bell, Loader2, Search, RefreshCw, Plus, Trash2, Edit2, 
  CheckCircle, AlertTriangle, Info, AlertCircle, X,
  Mail, Smartphone, MessageSquare, Settings, FileText,
  Eye, EyeOff, Send, Clock, Users, Globe, PartyPopper
} from 'lucide-react';
import { CampaignHeadsUpSection } from '@/components/notifications/CampaignHeadsUpSection';
import { format } from 'date-fns';
import { toast } from 'sonner';

interface Notification {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error' | 'alert';
  category: string;
  title: string;
  message: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  target_audience: string;
  target_region_id: string | null;
  target_service_area_id: string | null;
  target_user_id: string | null;
  is_read: boolean;
  is_dismissed: boolean;
  action_url: string | null;
  action_label: string | null;
  metadata: Record<string, unknown>;
  expires_at: string | null;
  created_at: string;
  created_by: string | null;
}

interface NotificationTemplate {
  id: string;
  name: string;
  type: string;
  category: string;
  title_template: string;
  message_template: string;
  priority: string;
  is_active: boolean;
  created_at: string;
}

interface NotificationSetting {
  id: string;
  setting_key: string;
  setting_value: Record<string, unknown>;
  description: string | null;
}

interface Region {
  id: string;
  name: string;
}

interface ServiceArea {
  id: string;
  name: string;
  region_id: string;
}

const NOTIFICATION_TYPES = [
  { value: 'info', label: 'Info', icon: Info, color: 'text-blue-500' },
  { value: 'success', label: 'Success', icon: CheckCircle, color: 'text-green-500' },
  { value: 'warning', label: 'Warning', icon: AlertTriangle, color: 'text-yellow-500' },
  { value: 'error', label: 'Error', icon: AlertCircle, color: 'text-red-500' },
  { value: 'alert', label: 'Alert', icon: Bell, color: 'text-orange-500' },
];

const NOTIFICATION_CATEGORIES = [
  'system', 'trip', 'driver', 'rider', 'payment', 'dispatch', 'maintenance', 'security', 'promotion'
];

const PRIORITY_LEVELS = [
  { value: 'low', label: 'Low', color: 'bg-slate-100 text-slate-700' },
  { value: 'normal', label: 'Normal', color: 'bg-blue-100 text-blue-700' },
  { value: 'high', label: 'High', color: 'bg-orange-100 text-orange-700' },
  { value: 'urgent', label: 'Urgent', color: 'bg-red-100 text-red-700' },
];

const TARGET_AUDIENCES = [
  { value: 'all', label: 'Everyone' },
  { value: 'admins', label: 'Admins Only' },
  { value: 'drivers', label: 'All Drivers' },
  { value: 'riders', label: 'All Riders' },
  { value: 'region', label: 'Specific Region' },
  { value: 'service_area', label: 'Specific Service Area' },
];

export default function Notifications() {
  const [activeTab, setActiveTab] = useState('notifications');
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [templates, setTemplates] = useState<NotificationTemplate[]>([]);
  const [settings, setSettings] = useState<NotificationSetting[]>([]);
  
  // Use shared cached hooks for regions & service areas
  const { data: regions = [] } = useRegions();
  const { data: serviceAreas = [] } = useServiceAreas({ activeOnly: true });
  
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [filterCategory, setFilterCategory] = useState('all');
  
  // Dialog states
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [selectedNotification, setSelectedNotification] = useState<Notification | null>(null);
  const [isTemplateDialogOpen, setIsTemplateDialogOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<NotificationTemplate | null>(null);
  
  // Form state
  const [formData, setFormData] = useState({
    type: 'info',
    category: 'system',
    title: '',
    message: '',
    priority: 'normal',
    target_audience: 'all',
    target_region_id: '',
    target_service_area_id: '',
    action_url: '',
    action_label: '',
    expires_at: '',
  });

  // Template form state
  const [templateFormData, setTemplateFormData] = useState({
    name: '',
    type: 'info',
    category: 'system',
    title_template: '',
    message_template: '',
    priority: 'normal',
    is_active: true,
  });

  // Settings state
  const [emailSettings, setEmailSettings] = useState({
    enabled: true,
    trip_updates: true,
    driver_alerts: true,
    payment_alerts: true,
    system_alerts: true,
  });
  
  const [pushSettings, setPushSettings] = useState({
    enabled: true,
    trip_updates: true,
    driver_alerts: true,
    payment_alerts: true,
    system_alerts: true,
  });
  
  const [smsSettings, setSmsSettings] = useState({
    enabled: false,
    urgent_only: true,
  });
  
  const [alertThresholds, setAlertThresholds] = useState({
    low_driver_count: 5,
    high_wait_time_minutes: 10,
    high_cancellation_rate: 20,
    payment_failure_count: 3,
  });

  const [quietHours, setQuietHours] = useState({
    enabled: false,
    start: '22:00',
    end: '07:00',
    timezone: 'Europe/London',
  });

  // Fetch notifications data (regions/service areas come from shared hooks now)
  const { data: _notifData } = useQuery({
    queryKey: ['notifications-data'],
    queryFn: async () => {
      const [notifRes, templatesRes, settingsRes] = await Promise.all([
        supabase
          .from('notifications')
          .select('id, type, category, title, message, priority, target_audience, target_region_id, target_service_area_id, target_user_id, is_read, is_dismissed, action_url, action_label, metadata, expires_at, created_at, created_by')
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('notification_templates')
          .select('id, name, type, category, title_template, message_template, priority, is_active, created_at')
          .order('name'),
        supabase
          .from('notification_settings')
          .select('id, setting_key, setting_value, description'),
      ]);

      if (notifRes.error) throw notifRes.error;
      if (templatesRes.error) throw templatesRes.error;
      if (settingsRes.error) throw settingsRes.error;

      // Side-effect: update local state for settings parsing
      setNotifications(notifRes.data as Notification[] || []);
      setTemplates(templatesRes.data as NotificationTemplate[] || []);
      setSettings(settingsRes.data as NotificationSetting[] || []);

      // Parse settings
      const emailSetting = settingsRes.data?.find(s => s.setting_key === 'email_notifications');
      const pushSetting = settingsRes.data?.find(s => s.setting_key === 'push_notifications');
      const smsSetting = settingsRes.data?.find(s => s.setting_key === 'sms_notifications');
      const thresholdSetting = settingsRes.data?.find(s => s.setting_key === 'alert_thresholds');
      const quietSetting = settingsRes.data?.find(s => s.setting_key === 'quiet_hours');

      if (emailSetting) setEmailSettings(emailSetting.setting_value as typeof emailSettings);
      if (pushSetting) setPushSettings(pushSetting.setting_value as typeof pushSettings);
      if (smsSetting) setSmsSettings(smsSetting.setting_value as typeof smsSettings);
      if (thresholdSetting) setAlertThresholds(thresholdSetting.setting_value as typeof alertThresholds);
      if (quietSetting) setQuietHours(quietSetting.setting_value as typeof quietHours);

      setIsLoading(false);
      return { notifications: notifRes.data, templates: templatesRes.data, settings: settingsRes.data };
    },
    staleTime: 30_000,
  });

  const fetchData = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['notifications-data'] });
  }, [queryClient]);

  // Create notification
  const handleCreateNotification = async () => {
    try {
      setIsSaving(true);
      
      const { error } = await supabase.from('notifications').insert({
        type: formData.type,
        category: formData.category,
        title: formData.title,
        message: formData.message,
        priority: formData.priority,
        target_audience: formData.target_audience,
        target_region_id: formData.target_region_id || null,
        target_service_area_id: formData.target_service_area_id || null,
        action_url: formData.action_url || null,
        action_label: formData.action_label || null,
        expires_at: formData.expires_at || null,
      });

      if (error) throw error;

      toast.success('Notification created successfully');
      setIsCreateOpen(false);
      resetForm();
      fetchData();
    } catch (err) {
      console.error('Error creating notification:', err);
      toast.error('Failed to create notification');
    } finally {
      setIsSaving(false);
    }
  };

  // Update notification
  const handleUpdateNotification = async () => {
    if (!selectedNotification) return;
    
    try {
      setIsSaving(true);
      
      const { error } = await supabase
        .from('notifications')
        .update({
          type: formData.type,
          category: formData.category,
          title: formData.title,
          message: formData.message,
          priority: formData.priority,
          target_audience: formData.target_audience,
          target_region_id: formData.target_region_id || null,
          target_service_area_id: formData.target_service_area_id || null,
          action_url: formData.action_url || null,
          action_label: formData.action_label || null,
          expires_at: formData.expires_at || null,
        })
        .eq('id', selectedNotification.id);

      if (error) throw error;

      toast.success('Notification updated successfully');
      setIsEditOpen(false);
      resetForm();
      fetchData();
    } catch (err) {
      console.error('Error updating notification:', err);
      toast.error('Failed to update notification');
    } finally {
      setIsSaving(false);
    }
  };

  // Delete notification
  const handleDeleteNotification = async () => {
    if (!selectedNotification) return;
    
    try {
      const { error } = await supabase
        .from('notifications')
        .delete()
        .eq('id', selectedNotification.id);

      if (error) throw error;

      toast.success('Notification deleted');
      setIsDeleteOpen(false);
      setSelectedNotification(null);
      fetchData();
    } catch (err) {
      console.error('Error deleting notification:', err);
      toast.error('Failed to delete notification');
    }
  };

  // Mark as read/unread
  const handleToggleRead = async (notification: Notification) => {
    try {
      const { error } = await supabase
        .from('notifications')
        .update({ is_read: !notification.is_read })
        .eq('id', notification.id);

      if (error) throw error;
      fetchData();
    } catch (err) {
      console.error('Error toggling read status:', err);
    }
  };

  // Dismiss notification
  const handleDismiss = async (notification: Notification) => {
    try {
      const { error } = await supabase
        .from('notifications')
        .update({ is_dismissed: true })
        .eq('id', notification.id);

      if (error) throw error;
      toast.success('Notification dismissed');
      fetchData();
    } catch (err) {
      console.error('Error dismissing notification:', err);
    }
  };

  // Save template
  const handleSaveTemplate = async () => {
    try {
      setIsSaving(true);
      
      if (selectedTemplate) {
        const { error } = await supabase
          .from('notification_templates')
          .update(templateFormData)
          .eq('id', selectedTemplate.id);
        if (error) throw error;
        toast.success('Template updated');
      } else {
        const { error } = await supabase
          .from('notification_templates')
          .insert(templateFormData);
        if (error) throw error;
        toast.success('Template created');
      }

      setIsTemplateDialogOpen(false);
      resetTemplateForm();
      fetchData();
    } catch (err) {
      console.error('Error saving template:', err);
      toast.error('Failed to save template');
    } finally {
      setIsSaving(false);
    }
  };

  // Delete template
  const handleDeleteTemplate = async (template: NotificationTemplate) => {
    try {
      const { error } = await supabase
        .from('notification_templates')
        .delete()
        .eq('id', template.id);

      if (error) throw error;
      toast.success('Template deleted');
      fetchData();
    } catch (err) {
      console.error('Error deleting template:', err);
      toast.error('Failed to delete template');
    }
  };

  // Save settings
  const handleSaveSettings = async () => {
    try {
      setIsSaving(true);

      const updates = [
        { setting_key: 'email_notifications', setting_value: emailSettings },
        { setting_key: 'push_notifications', setting_value: pushSettings },
        { setting_key: 'sms_notifications', setting_value: smsSettings },
        { setting_key: 'alert_thresholds', setting_value: alertThresholds },
        { setting_key: 'quiet_hours', setting_value: quietHours },
      ];

      for (const update of updates) {
        const { error } = await supabase
          .from('notification_settings')
          .update({ setting_value: update.setting_value })
          .eq('setting_key', update.setting_key);
        if (error) throw error;
      }

      toast.success('Settings saved successfully');
    } catch (err) {
      console.error('Error saving settings:', err);
      toast.error('Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  // Reset form
  const resetForm = () => {
    setFormData({
      type: 'info',
      category: 'system',
      title: '',
      message: '',
      priority: 'normal',
      target_audience: 'all',
      target_region_id: '',
      target_service_area_id: '',
      action_url: '',
      action_label: '',
      expires_at: '',
    });
    setSelectedNotification(null);
  };

  const resetTemplateForm = () => {
    setTemplateFormData({
      name: '',
      type: 'info',
      category: 'system',
      title_template: '',
      message_template: '',
      priority: 'normal',
      is_active: true,
    });
    setSelectedTemplate(null);
  };

  // Open edit dialog
  const openEditDialog = (notification: Notification) => {
    setSelectedNotification(notification);
    setFormData({
      type: notification.type,
      category: notification.category,
      title: notification.title,
      message: notification.message,
      priority: notification.priority,
      target_audience: notification.target_audience,
      target_region_id: notification.target_region_id || '',
      target_service_area_id: notification.target_service_area_id || '',
      action_url: notification.action_url || '',
      action_label: notification.action_label || '',
      expires_at: notification.expires_at || '',
    });
    setIsEditOpen(true);
  };

  // Open template edit dialog
  const openTemplateDialog = (template?: NotificationTemplate) => {
    if (template) {
      setSelectedTemplate(template);
      setTemplateFormData({
        name: template.name,
        type: template.type,
        category: template.category,
        title_template: template.title_template,
        message_template: template.message_template,
        priority: template.priority,
        is_active: template.is_active,
      });
    } else {
      resetTemplateForm();
    }
    setIsTemplateDialogOpen(true);
  };

  // Filter notifications
  const filteredNotifications = notifications.filter(n => {
    if (n.is_dismissed) return false;
    
    const matchesSearch = 
      n.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      n.message.toLowerCase().includes(searchQuery.toLowerCase());
    
    const matchesType = filterType === 'all' || n.type === filterType;
    const matchesCategory = filterCategory === 'all' || n.category === filterCategory;
    
    return matchesSearch && matchesType && matchesCategory;
  });

  // Get type icon
  const getTypeIcon = (type: string) => {
    const typeInfo = NOTIFICATION_TYPES.find(t => t.value === type);
    if (!typeInfo) return <Info className="h-4 w-4" />;
    const Icon = typeInfo.icon;
    return <Icon className={`h-4 w-4 ${typeInfo.color}`} />;
  };

  // Get priority badge
  const getPriorityBadge = (priority: string) => {
    const priorityInfo = PRIORITY_LEVELS.find(p => p.value === priority);
    return (
      <Badge variant="outline" className={priorityInfo?.color || ''}>
        {priority}
      </Badge>
    );
  };

  // Stats
  const unreadCount = notifications.filter(n => !n.is_read && !n.is_dismissed).length;
  const urgentCount = notifications.filter(n => n.priority === 'urgent' && !n.is_dismissed).length;
  const todayCount = notifications.filter(n => {
    const today = new Date();
    const created = new Date(n.created_at);
    return created.toDateString() === today.toDateString() && !n.is_dismissed;
  }).length;

  return (
    <AdminLayout 
      title="Notifications & Alerts" 
      description="Manage system notifications, alerts, and notification settings"
    >
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Notifications</p>
                <p className="text-2xl font-bold">{notifications.filter(n => !n.is_dismissed).length}</p>
              </div>
              <Bell className="h-8 w-8 text-primary opacity-80" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-blue-500/30 bg-blue-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Unread</p>
                <p className="text-2xl font-bold text-blue-600">{unreadCount}</p>
              </div>
              <EyeOff className="h-8 w-8 text-blue-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-red-500/30 bg-red-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Urgent</p>
                <p className="text-2xl font-bold text-red-600">{urgentCount}</p>
              </div>
              <AlertCircle className="h-8 w-8 text-red-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-green-500/30 bg-green-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Today</p>
                <p className="text-2xl font-bold text-green-600">{todayCount}</p>
              </div>
              <Clock className="h-8 w-8 text-green-500" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="notifications" className="flex items-center gap-2">
            <Bell className="h-4 w-4" />
            Notifications
          </TabsTrigger>
          <TabsTrigger value="templates" className="flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Templates
          </TabsTrigger>
          <TabsTrigger value="campaign-heads-up" className="flex items-center gap-2">
            <PartyPopper className="h-4 w-4" />
            Campaign / Celebration
          </TabsTrigger>
          <TabsTrigger value="settings" className="flex items-center gap-2">
            <Settings className="h-4 w-4" />
            Settings
          </TabsTrigger>
        </TabsList>

        {/* Notifications Tab */}
        <TabsContent value="notifications">
          <Card>
            <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Bell className="h-5 w-5 text-primary" />
                  All Notifications
                </CardTitle>
                <CardDescription>View and manage system notifications</CardDescription>
              </div>
              <div className="flex flex-col gap-2 md:flex-row md:items-center">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search..."
                    className="pl-9 w-full md:w-[180px]"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
                <Select value={filterType} onValueChange={setFilterType}>
                  <SelectTrigger className="w-full md:w-[120px]">
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    {NOTIFICATION_TYPES.map(type => (
                      <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={filterCategory} onValueChange={setFilterCategory}>
                  <SelectTrigger className="w-full md:w-[130px]">
                    <SelectValue placeholder="Category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    {NOTIFICATION_CATEGORIES.map(cat => (
                      <SelectItem key={cat} value={cat} className="capitalize">{cat}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button variant="outline" onClick={() => fetchData()} disabled={isLoading}>
                  <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
                  Refresh
                </Button>
                <Button variant="outline" onClick={() => setActiveTab('campaign-heads-up')}>
                  <PartyPopper className="h-4 w-4 mr-2" />
                  Campaign Heads-Up
                </Button>
                <Button onClick={() => setIsCreateOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  New
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : filteredNotifications.length === 0 ? (
                <div className="py-12 text-center">
                  <Bell className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                  <h3 className="text-lg font-medium mb-2">No notifications</h3>
                  <p className="text-muted-foreground">Create a new notification to get started</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[50px]">Type</TableHead>
                      <TableHead>Title</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Priority</TableHead>
                      <TableHead>Target</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredNotifications.map((notification) => (
                      <TableRow key={notification.id} className={!notification.is_read ? 'bg-muted/30' : ''}>
                        <TableCell>{getTypeIcon(notification.type)}</TableCell>
                        <TableCell>
                          <div>
                            <p className="font-medium">{notification.title}</p>
                            <p className="text-xs text-muted-foreground truncate max-w-[200px]">
                              {notification.message}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="capitalize">{notification.category}</Badge>
                        </TableCell>
                        <TableCell>{getPriorityBadge(notification.priority)}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            {notification.target_audience === 'all' && <Globe className="h-3 w-3" />}
                            {notification.target_audience === 'admins' && <Users className="h-3 w-3" />}
                            <span className="text-xs capitalize">{notification.target_audience}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          {notification.is_read ? (
                            <Badge variant="secondary" className="text-xs">Read</Badge>
                          ) : (
                            <Badge variant="default" className="text-xs">Unread</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {format(new Date(notification.created_at), 'MMM d, HH:mm')}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button 
                              variant="ghost" 
                              size="sm"
                              onClick={() => handleToggleRead(notification)}
                              title={notification.is_read ? 'Mark as unread' : 'Mark as read'}
                            >
                              {notification.is_read ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </Button>
                            <Button 
                              variant="ghost" 
                              size="sm"
                              onClick={() => openEditDialog(notification)}
                            >
                              <Edit2 className="h-4 w-4" />
                            </Button>
                            <Button 
                              variant="ghost" 
                              size="sm"
                              onClick={() => handleDismiss(notification)}
                              title="Dismiss"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                            <Button 
                              variant="ghost" 
                              size="sm"
                              onClick={() => {
                                setSelectedNotification(notification);
                                setIsDeleteOpen(true);
                              }}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Templates Tab */}
        <TabsContent value="templates">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5 text-primary" />
                  Notification Templates
                </CardTitle>
                <CardDescription>Reusable templates for common notifications</CardDescription>
              </div>
              <Button onClick={() => openTemplateDialog()}>
                <Plus className="h-4 w-4 mr-2" />
                New Template
              </Button>
            </CardHeader>
            <CardContent>
              {templates.length === 0 ? (
                <div className="py-12 text-center">
                  <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                  <h3 className="text-lg font-medium mb-2">No templates</h3>
                  <p className="text-muted-foreground">Create reusable notification templates</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Title Template</TableHead>
                      <TableHead>Priority</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {templates.map((template) => (
                      <TableRow key={template.id}>
                        <TableCell className="font-medium">{template.name}</TableCell>
                        <TableCell>{getTypeIcon(template.type)}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="capitalize">{template.category}</Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                          {template.title_template}
                        </TableCell>
                        <TableCell>{getPriorityBadge(template.priority)}</TableCell>
                        <TableCell>
                          {template.is_active ? (
                            <Badge variant="default" className="bg-green-500">Active</Badge>
                          ) : (
                            <Badge variant="secondary">Inactive</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button 
                              variant="ghost" 
                              size="sm"
                              onClick={() => openTemplateDialog(template)}
                            >
                              <Edit2 className="h-4 w-4" />
                            </Button>
                            <Button 
                              variant="ghost" 
                              size="sm"
                              onClick={() => handleDeleteTemplate(template)}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Settings Tab */}
        <TabsContent value="campaign-heads-up">
          <CampaignHeadsUpSection />
        </TabsContent>

        <TabsContent value="settings">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Email Notifications */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Mail className="h-5 w-5 text-primary" />
                  Email Notifications
                </CardTitle>
                <CardDescription>Configure email notification preferences</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label>Enable Email Notifications</Label>
                  <Switch 
                    checked={emailSettings.enabled} 
                    onCheckedChange={(v) => setEmailSettings(s => ({ ...s, enabled: v }))}
                  />
                </div>
                <Separator />
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">Trip Updates</Label>
                    <Switch 
                      checked={emailSettings.trip_updates} 
                      onCheckedChange={(v) => setEmailSettings(s => ({ ...s, trip_updates: v }))}
                      disabled={!emailSettings.enabled}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">Driver Alerts</Label>
                    <Switch 
                      checked={emailSettings.driver_alerts} 
                      onCheckedChange={(v) => setEmailSettings(s => ({ ...s, driver_alerts: v }))}
                      disabled={!emailSettings.enabled}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">Payment Alerts</Label>
                    <Switch 
                      checked={emailSettings.payment_alerts} 
                      onCheckedChange={(v) => setEmailSettings(s => ({ ...s, payment_alerts: v }))}
                      disabled={!emailSettings.enabled}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">System Alerts</Label>
                    <Switch 
                      checked={emailSettings.system_alerts} 
                      onCheckedChange={(v) => setEmailSettings(s => ({ ...s, system_alerts: v }))}
                      disabled={!emailSettings.enabled}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Push Notifications */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Smartphone className="h-5 w-5 text-primary" />
                  Push Notifications
                </CardTitle>
                <CardDescription>Configure push notification preferences</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label>Enable Push Notifications</Label>
                  <Switch 
                    checked={pushSettings.enabled} 
                    onCheckedChange={(v) => setPushSettings(s => ({ ...s, enabled: v }))}
                  />
                </div>
                <Separator />
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">Trip Updates</Label>
                    <Switch 
                      checked={pushSettings.trip_updates} 
                      onCheckedChange={(v) => setPushSettings(s => ({ ...s, trip_updates: v }))}
                      disabled={!pushSettings.enabled}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">Driver Alerts</Label>
                    <Switch 
                      checked={pushSettings.driver_alerts} 
                      onCheckedChange={(v) => setPushSettings(s => ({ ...s, driver_alerts: v }))}
                      disabled={!pushSettings.enabled}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">Payment Alerts</Label>
                    <Switch 
                      checked={pushSettings.payment_alerts} 
                      onCheckedChange={(v) => setPushSettings(s => ({ ...s, payment_alerts: v }))}
                      disabled={!pushSettings.enabled}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">System Alerts</Label>
                    <Switch 
                      checked={pushSettings.system_alerts} 
                      onCheckedChange={(v) => setPushSettings(s => ({ ...s, system_alerts: v }))}
                      disabled={!pushSettings.enabled}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* SMS Notifications */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MessageSquare className="h-5 w-5 text-primary" />
                  SMS Notifications
                </CardTitle>
                <CardDescription>Configure SMS notification preferences</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label>Enable SMS Notifications</Label>
                  <Switch 
                    checked={smsSettings.enabled} 
                    onCheckedChange={(v) => setSmsSettings(s => ({ ...s, enabled: v }))}
                  />
                </div>
                <Separator />
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Urgent Notifications Only</Label>
                  <Switch 
                    checked={smsSettings.urgent_only} 
                    onCheckedChange={(v) => setSmsSettings(s => ({ ...s, urgent_only: v }))}
                    disabled={!smsSettings.enabled}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Alert Thresholds */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-primary" />
                  Alert Thresholds
                </CardTitle>
                <CardDescription>Configure when alerts are triggered</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Low Driver Count Threshold</Label>
                  <Input 
                    type="number" 
                    value={alertThresholds.low_driver_count}
                    onChange={(e) => setAlertThresholds(s => ({ ...s, low_driver_count: parseInt(e.target.value) || 0 }))}
                  />
                  <p className="text-xs text-muted-foreground">Alert when available drivers fall below this number</p>
                </div>
                <div className="space-y-2">
                  <Label>High Wait Time (minutes)</Label>
                  <Input 
                    type="number" 
                    value={alertThresholds.high_wait_time_minutes}
                    onChange={(e) => setAlertThresholds(s => ({ ...s, high_wait_time_minutes: parseInt(e.target.value) || 0 }))}
                  />
                  <p className="text-xs text-muted-foreground">Alert when average wait time exceeds this</p>
                </div>
                <div className="space-y-2">
                  <Label>High Cancellation Rate (%)</Label>
                  <Input 
                    type="number" 
                    value={alertThresholds.high_cancellation_rate}
                    onChange={(e) => setAlertThresholds(s => ({ ...s, high_cancellation_rate: parseInt(e.target.value) || 0 }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Payment Failure Count</Label>
                  <Input 
                    type="number" 
                    value={alertThresholds.payment_failure_count}
                    onChange={(e) => setAlertThresholds(s => ({ ...s, payment_failure_count: parseInt(e.target.value) || 0 }))}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Quiet Hours */}
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Clock className="h-5 w-5 text-primary" />
                  Quiet Hours
                </CardTitle>
                <CardDescription>Set times when non-urgent notifications are muted</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between mb-4">
                  <Label>Enable Quiet Hours</Label>
                  <Switch 
                    checked={quietHours.enabled} 
                    onCheckedChange={(v) => setQuietHours(s => ({ ...s, enabled: v }))}
                  />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label>Start Time</Label>
                    <Input 
                      type="time" 
                      value={quietHours.start}
                      onChange={(e) => setQuietHours(s => ({ ...s, start: e.target.value }))}
                      disabled={!quietHours.enabled}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>End Time</Label>
                    <Input 
                      type="time" 
                      value={quietHours.end}
                      onChange={(e) => setQuietHours(s => ({ ...s, end: e.target.value }))}
                      disabled={!quietHours.enabled}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Timezone</Label>
                    <Select 
                      value={quietHours.timezone} 
                      onValueChange={(v) => setQuietHours(s => ({ ...s, timezone: v }))}
                      disabled={!quietHours.enabled}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Europe/London">Europe/London</SelectItem>
                        <SelectItem value="America/New_York">America/New York</SelectItem>
                        <SelectItem value="America/Los_Angeles">America/Los Angeles</SelectItem>
                        <SelectItem value="Asia/Tokyo">Asia/Tokyo</SelectItem>
                        <SelectItem value="Australia/Sydney">Australia/Sydney</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Save Button */}
          <div className="flex justify-end mt-6">
            <Button onClick={handleSaveSettings} disabled={isSaving}>
              {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save Settings
            </Button>
          </div>
        </TabsContent>
      </Tabs>

      {/* Create/Edit Notification Dialog */}
      <Dialog open={isCreateOpen || isEditOpen} onOpenChange={(open) => {
        if (!open) {
          setIsCreateOpen(false);
          setIsEditOpen(false);
          resetForm();
        }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {isEditOpen ? 'Edit Notification' : 'Create New Notification'}
            </DialogTitle>
            <DialogDescription>
              {isEditOpen ? 'Update the notification details' : 'Send a notification to users'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={formData.type} onValueChange={(v) => setFormData(s => ({ ...s, type: v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NOTIFICATION_TYPES.map(type => (
                    <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Category</Label>
              <Select value={formData.category} onValueChange={(v) => setFormData(s => ({ ...s, category: v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NOTIFICATION_CATEGORIES.map(cat => (
                    <SelectItem key={cat} value={cat} className="capitalize">{cat}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 space-y-2">
              <Label>Title</Label>
              <Input 
                value={formData.title}
                onChange={(e) => setFormData(s => ({ ...s, title: e.target.value }))}
                placeholder="Notification title"
              />
            </div>
            <div className="col-span-2 space-y-2">
              <Label>Message</Label>
              <Textarea 
                value={formData.message}
                onChange={(e) => setFormData(s => ({ ...s, message: e.target.value }))}
                placeholder="Notification message"
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label>Priority</Label>
              <Select value={formData.priority} onValueChange={(v) => setFormData(s => ({ ...s, priority: v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITY_LEVELS.map(p => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Target Audience</Label>
              <Select value={formData.target_audience} onValueChange={(v) => setFormData(s => ({ ...s, target_audience: v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TARGET_AUDIENCES.map(t => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {formData.target_audience === 'region' && (
              <div className="space-y-2">
                <Label>Region</Label>
                <Select value={formData.target_region_id} onValueChange={(v) => setFormData(s => ({ ...s, target_region_id: v }))}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select region" />
                  </SelectTrigger>
                  <SelectContent>
                    {regions.map(r => (
                      <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {formData.target_audience === 'service_area' && (
              <div className="space-y-2">
                <Label>Service Area</Label>
                <Select value={formData.target_service_area_id} onValueChange={(v) => setFormData(s => ({ ...s, target_service_area_id: v }))}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select service area" />
                  </SelectTrigger>
                  <SelectContent>
                    {serviceAreas.map(sa => (
                      <SelectItem key={sa.id} value={sa.id}>{sa.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label>Action URL (optional)</Label>
              <Input 
                value={formData.action_url}
                onChange={(e) => setFormData(s => ({ ...s, action_url: e.target.value }))}
                placeholder="/dashboard"
              />
            </div>
            <div className="space-y-2">
              <Label>Action Label (optional)</Label>
              <Input 
                value={formData.action_label}
                onChange={(e) => setFormData(s => ({ ...s, action_label: e.target.value }))}
                placeholder="View Details"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setIsCreateOpen(false);
              setIsEditOpen(false);
              resetForm();
            }}>
              Cancel
            </Button>
            <Button 
              onClick={isEditOpen ? handleUpdateNotification : handleCreateNotification}
              disabled={isSaving || !formData.title || !formData.message}
            >
              {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              <Send className="h-4 w-4 mr-2" />
              {isEditOpen ? 'Update' : 'Send Notification'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Template Dialog */}
      <Dialog open={isTemplateDialogOpen} onOpenChange={(open) => {
        if (!open) {
          setIsTemplateDialogOpen(false);
          resetTemplateForm();
        }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {selectedTemplate ? 'Edit Template' : 'Create New Template'}
            </DialogTitle>
            <DialogDescription>
              Create reusable notification templates with placeholders
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 space-y-2">
              <Label>Template Name</Label>
              <Input 
                value={templateFormData.name}
                onChange={(e) => setTemplateFormData(s => ({ ...s, name: e.target.value }))}
                placeholder="e.g., new_driver_signup"
              />
            </div>
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={templateFormData.type} onValueChange={(v) => setTemplateFormData(s => ({ ...s, type: v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NOTIFICATION_TYPES.map(type => (
                    <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Category</Label>
              <Select value={templateFormData.category} onValueChange={(v) => setTemplateFormData(s => ({ ...s, category: v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NOTIFICATION_CATEGORIES.map(cat => (
                    <SelectItem key={cat} value={cat} className="capitalize">{cat}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 space-y-2">
              <Label>Title Template</Label>
              <Input 
                value={templateFormData.title_template}
                onChange={(e) => setTemplateFormData(s => ({ ...s, title_template: e.target.value }))}
                placeholder="Use {{variable}} for placeholders"
              />
            </div>
            <div className="col-span-2 space-y-2">
              <Label>Message Template</Label>
              <Textarea 
                value={templateFormData.message_template}
                onChange={(e) => setTemplateFormData(s => ({ ...s, message_template: e.target.value }))}
                placeholder="Use {{variable}} for placeholders"
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label>Priority</Label>
              <Select value={templateFormData.priority} onValueChange={(v) => setTemplateFormData(s => ({ ...s, priority: v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITY_LEVELS.map(p => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2 pt-6">
              <Switch 
                checked={templateFormData.is_active}
                onCheckedChange={(v) => setTemplateFormData(s => ({ ...s, is_active: v }))}
              />
              <Label>Active</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setIsTemplateDialogOpen(false);
              resetTemplateForm();
            }}>
              Cancel
            </Button>
            <Button 
              onClick={handleSaveTemplate}
              disabled={isSaving || !templateFormData.name || !templateFormData.title_template}
            >
              {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {selectedTemplate ? 'Update Template' : 'Create Template'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Notification</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this notification? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteNotification} className="bg-destructive text-destructive-foreground">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminLayout>
  );
}
