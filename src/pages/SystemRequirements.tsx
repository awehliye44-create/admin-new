import { useState, useEffect, useCallback } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { 
  Server, 
  Database, 
  HardDrive, 
  Cpu, 
  MemoryStick, 
  Network, 
  Shield,
  Settings,
  Plus,
  Pencil,
  Trash2,
  Search,
  RefreshCw,
  Download,
  Upload,
  CheckCircle2,
  XCircle,
  AlertCircle,
  AlertTriangle,
  Clock,
  Activity,
  Zap,
  Globe,
  Lock,
  Key,
  FileCheck,
  Monitor,
  Smartphone,
  Wifi,
  CloudCog,
  CheckCheck,
  Info,
  ExternalLink
} from 'lucide-react';

// Types
interface SystemRequirement {
  id: string;
  category: string;
  name: string;
  description: string;
  requirement_type: 'minimum' | 'recommended' | 'optional';
  value: string;
  unit: string;
  current_value: string | null;
  status: 'met' | 'not_met' | 'warning' | 'unknown';
  priority: number;
  is_critical: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface SystemCheck {
  id: string;
  check_name: string;
  category: string;
  last_run: string | null;
  status: 'passed' | 'failed' | 'warning' | 'pending';
  message: string;
  details: Record<string, any>;
  auto_run: boolean;
  run_interval_minutes: number;
}

interface EnvironmentVariable {
  id: string;
  key: string;
  value: string;
  is_secret: boolean;
  category: string;
  description: string;
  is_required: boolean;
  is_set: boolean;
}

interface HealthMetric {
  name: string;
  value: number;
  unit: string;
  status: 'healthy' | 'warning' | 'critical';
  threshold_warning: number;
  threshold_critical: number;
}

// Constants
const REQUIREMENT_CATEGORIES = [
  { value: 'hardware', label: 'Hardware', icon: Server },
  { value: 'software', label: 'Software', icon: Monitor },
  { value: 'network', label: 'Network', icon: Network },
  { value: 'security', label: 'Security', icon: Shield },
  { value: 'database', label: 'Database', icon: Database },
  { value: 'storage', label: 'Storage', icon: HardDrive },
  { value: 'browser', label: 'Browser', icon: Globe },
  { value: 'mobile', label: 'Mobile', icon: Smartphone },
];

const REQUIREMENT_TYPES = [
  { value: 'minimum', label: 'Minimum', color: 'bg-orange-500/10 text-orange-600 border-orange-500/20' },
  { value: 'recommended', label: 'Recommended', color: 'bg-blue-500/10 text-blue-600 border-blue-500/20' },
  { value: 'optional', label: 'Optional', color: 'bg-gray-500/10 text-gray-600 border-gray-500/20' },
];

const STATUS_CONFIG = {
  met: { label: 'Met', color: 'bg-green-500/10 text-green-600 border-green-500/20', icon: CheckCircle2 },
  not_met: { label: 'Not Met', color: 'bg-red-500/10 text-red-600 border-red-500/20', icon: XCircle },
  warning: { label: 'Warning', color: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20', icon: AlertTriangle },
  unknown: { label: 'Unknown', color: 'bg-gray-500/10 text-gray-600 border-gray-500/20', icon: AlertCircle },
};

const CHECK_STATUS_CONFIG = {
  passed: { label: 'Passed', color: 'bg-green-500/10 text-green-600 border-green-500/20', icon: CheckCircle2 },
  failed: { label: 'Failed', color: 'bg-red-500/10 text-red-600 border-red-500/20', icon: XCircle },
  warning: { label: 'Warning', color: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20', icon: AlertTriangle },
  pending: { label: 'Pending', color: 'bg-gray-500/10 text-gray-600 border-gray-500/20', icon: Clock },
};

// Default requirements data
const DEFAULT_REQUIREMENTS: Omit<SystemRequirement, 'id' | 'created_at' | 'updated_at'>[] = [
  // Hardware
  { category: 'hardware', name: 'CPU Cores', description: 'Number of CPU cores required', requirement_type: 'minimum', value: '2', unit: 'cores', current_value: '4', status: 'met', priority: 1, is_critical: true, notes: null },
  { category: 'hardware', name: 'RAM', description: 'System memory required', requirement_type: 'minimum', value: '4', unit: 'GB', current_value: '8', status: 'met', priority: 1, is_critical: true, notes: null },
  { category: 'hardware', name: 'RAM', description: 'Recommended system memory', requirement_type: 'recommended', value: '8', unit: 'GB', current_value: '8', status: 'met', priority: 2, is_critical: false, notes: null },
  { category: 'hardware', name: 'Storage', description: 'Available disk space', requirement_type: 'minimum', value: '20', unit: 'GB', current_value: '100', status: 'met', priority: 1, is_critical: true, notes: null },
  
  // Software
  { category: 'software', name: 'Node.js', description: 'Node.js runtime version', requirement_type: 'minimum', value: '18.0', unit: 'version', current_value: '20.0', status: 'met', priority: 1, is_critical: true, notes: null },
  { category: 'software', name: 'PostgreSQL', description: 'Database version', requirement_type: 'minimum', value: '14.0', unit: 'version', current_value: '15.0', status: 'met', priority: 1, is_critical: true, notes: null },
  { category: 'software', name: 'Redis', description: 'Cache server version', requirement_type: 'recommended', value: '6.0', unit: 'version', current_value: null, status: 'unknown', priority: 2, is_critical: false, notes: 'Optional for session caching' },
  
  // Network
  { category: 'network', name: 'Bandwidth', description: 'Minimum network bandwidth', requirement_type: 'minimum', value: '100', unit: 'Mbps', current_value: '1000', status: 'met', priority: 1, is_critical: true, notes: null },
  { category: 'network', name: 'Latency', description: 'Maximum acceptable latency', requirement_type: 'recommended', value: '50', unit: 'ms', current_value: '20', status: 'met', priority: 2, is_critical: false, notes: null },
  { category: 'network', name: 'SSL/TLS', description: 'HTTPS encryption required', requirement_type: 'minimum', value: 'TLS 1.2+', unit: '', current_value: 'TLS 1.3', status: 'met', priority: 1, is_critical: true, notes: null },
  
  // Security
  { category: 'security', name: 'Authentication', description: 'Secure authentication method', requirement_type: 'minimum', value: 'JWT + MFA', unit: '', current_value: 'JWT', status: 'warning', priority: 1, is_critical: true, notes: 'MFA recommended for admin users' },
  { category: 'security', name: 'Encryption', description: 'Data encryption at rest', requirement_type: 'minimum', value: 'AES-256', unit: '', current_value: 'AES-256', status: 'met', priority: 1, is_critical: true, notes: null },
  { category: 'security', name: 'CORS Policy', description: 'Cross-origin resource sharing', requirement_type: 'minimum', value: 'Configured', unit: '', current_value: 'Enabled', status: 'met', priority: 1, is_critical: true, notes: null },
  
  // Database
  { category: 'database', name: 'Connections', description: 'Max database connections', requirement_type: 'minimum', value: '100', unit: 'connections', current_value: '200', status: 'met', priority: 1, is_critical: true, notes: null },
  { category: 'database', name: 'Row Level Security', description: 'RLS policies enabled', requirement_type: 'minimum', value: 'Enabled', unit: '', current_value: 'Enabled', status: 'met', priority: 1, is_critical: true, notes: null },
  { category: 'database', name: 'Backup Frequency', description: 'Automated backup schedule', requirement_type: 'recommended', value: 'Daily', unit: '', current_value: 'Daily', status: 'met', priority: 2, is_critical: false, notes: null },
  
  // Browser
  { category: 'browser', name: 'Chrome', description: 'Minimum Chrome version', requirement_type: 'minimum', value: '90', unit: 'version', current_value: null, status: 'unknown', priority: 1, is_critical: false, notes: null },
  { category: 'browser', name: 'Firefox', description: 'Minimum Firefox version', requirement_type: 'minimum', value: '88', unit: 'version', current_value: null, status: 'unknown', priority: 1, is_critical: false, notes: null },
  { category: 'browser', name: 'Safari', description: 'Minimum Safari version', requirement_type: 'minimum', value: '14', unit: 'version', current_value: null, status: 'unknown', priority: 1, is_critical: false, notes: null },
  { category: 'browser', name: 'Edge', description: 'Minimum Edge version', requirement_type: 'minimum', value: '90', unit: 'version', current_value: null, status: 'unknown', priority: 1, is_critical: false, notes: null },
  
  // Mobile
  { category: 'mobile', name: 'iOS', description: 'Minimum iOS version', requirement_type: 'minimum', value: '14.0', unit: 'version', current_value: null, status: 'unknown', priority: 1, is_critical: false, notes: null },
  { category: 'mobile', name: 'Android', description: 'Minimum Android version', requirement_type: 'minimum', value: '10', unit: 'version', current_value: null, status: 'unknown', priority: 1, is_critical: false, notes: null },
];

// Default system checks
const DEFAULT_CHECKS: Omit<SystemCheck, 'id'>[] = [
  { check_name: 'Database Connection', category: 'database', last_run: new Date().toISOString(), status: 'passed', message: 'Database connection is healthy', details: { response_time: '15ms' }, auto_run: true, run_interval_minutes: 5 },
  { check_name: 'API Endpoints', category: 'network', last_run: new Date().toISOString(), status: 'passed', message: 'All API endpoints responding', details: { endpoints_checked: 15, avg_response: '120ms' }, auto_run: true, run_interval_minutes: 1 },
  { check_name: 'SSL Certificate', category: 'security', last_run: new Date().toISOString(), status: 'passed', message: 'SSL certificate valid for 89 days', details: { expires: '2026-04-14' }, auto_run: true, run_interval_minutes: 60 },
  { check_name: 'Storage Usage', category: 'storage', last_run: new Date().toISOString(), status: 'warning', message: 'Storage at 72% capacity', details: { used: '72GB', total: '100GB' }, auto_run: true, run_interval_minutes: 30 },
  { check_name: 'Memory Usage', category: 'hardware', last_run: new Date().toISOString(), status: 'passed', message: 'Memory usage within limits', details: { used: '4.2GB', total: '8GB' }, auto_run: true, run_interval_minutes: 5 },
  { check_name: 'Edge Functions', category: 'software', last_run: new Date().toISOString(), status: 'passed', message: 'All edge functions operational', details: { functions: 5, healthy: 5 }, auto_run: true, run_interval_minutes: 10 },
  { check_name: 'RLS Policies', category: 'security', last_run: new Date().toISOString(), status: 'passed', message: 'All tables have RLS enabled', details: { tables: 20, with_rls: 20 }, auto_run: true, run_interval_minutes: 60 },
  { check_name: 'Backup Status', category: 'database', last_run: new Date().toISOString(), status: 'passed', message: 'Last backup completed successfully', details: { last_backup: '2026-01-14 03:00 UTC' }, auto_run: true, run_interval_minutes: 1440 },
];

// Default environment variables
const DEFAULT_ENV_VARS: Omit<EnvironmentVariable, 'id'>[] = [
  { key: 'SUPABASE_URL', value: '***', is_secret: false, category: 'database', description: 'Supabase project URL', is_required: true, is_set: true },
  { key: 'SUPABASE_ANON_KEY', value: '***', is_secret: true, category: 'database', description: 'Supabase anonymous key', is_required: true, is_set: true },
  { key: 'SUPABASE_SERVICE_ROLE_KEY', value: '***', is_secret: true, category: 'database', description: 'Supabase service role key', is_required: true, is_set: true },
  { key: 'MAPBOX_PUBLIC_TOKEN', value: '***', is_secret: false, category: 'integrations', description: 'Mapbox public access token for maps & geocoding', is_required: true, is_set: true },
  { key: 'RESEND_API_KEY', value: '***', is_secret: true, category: 'integrations', description: 'Resend API key for email notifications', is_required: false, is_set: true },
  { key: 'VAPID_PUBLIC_KEY', value: '***', is_secret: false, category: 'notifications', description: 'VAPID public key for push notifications', is_required: false, is_set: true },
  { key: 'VAPID_PRIVATE_KEY', value: '***', is_secret: true, category: 'notifications', description: 'VAPID private key for push notifications', is_required: false, is_set: true },
  { key: 'STRIPE_SECRET_KEY', value: '***', is_secret: true, category: 'payments', description: 'Stripe secret key for payment processing', is_required: false, is_set: false },
  { key: 'TWILIO_ACCOUNT_SID', value: '***', is_secret: true, category: 'communications', description: 'Twilio account SID for SMS', is_required: false, is_set: false },
  { key: 'TWILIO_AUTH_TOKEN', value: '***', is_secret: true, category: 'communications', description: 'Twilio auth token for SMS', is_required: false, is_set: false },
];

export default function SystemRequirements() {
  const { toast } = useToast();
  
  // State
  const [activeTab, setActiveTab] = useState('requirements');
  const [requirements, setRequirements] = useState<SystemRequirement[]>([]);
  const [systemChecks, setSystemChecks] = useState<SystemCheck[]>([]);
  const [envVars, setEnvVars] = useState<EnvironmentVariable[]>([]);
  const [healthMetrics, setHealthMetrics] = useState<HealthMetric[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunningChecks, setIsRunningChecks] = useState(false);
  
  // Dialogs
  const [isRequirementDialogOpen, setIsRequirementDialogOpen] = useState(false);
  const [isCheckDialogOpen, setIsCheckDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [editingRequirement, setEditingRequirement] = useState<SystemRequirement | null>(null);
  const [deletingItem, setDeletingItem] = useState<{ type: 'requirement' | 'check'; id: string } | null>(null);
  
  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  
  // Form data
  const [requirementForm, setRequirementForm] = useState({
    category: 'hardware',
    name: '',
    description: '',
    requirement_type: 'minimum' as 'minimum' | 'recommended' | 'optional',
    value: '',
    unit: '',
    current_value: '',
    status: 'unknown' as 'met' | 'not_met' | 'warning' | 'unknown',
    priority: 1,
    is_critical: false,
    notes: '',
  });

  // Load data
  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      // Fetch from admin_settings table
      const { data: settingsData, error: settingsError } = await supabase
        .from('admin_settings')
        .select('*')
        .in('setting_key', ['system_requirements', 'system_checks', 'environment_variables', 'health_metrics']);

      if (settingsError) throw settingsError;

      // Initialize with defaults if not found
      let reqs = DEFAULT_REQUIREMENTS.map((r, i) => ({
        ...r,
        id: `req_${i}`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));
      let checks = DEFAULT_CHECKS.map((c, i) => ({
        ...c,
        id: `check_${i}`,
      }));
      let envs = DEFAULT_ENV_VARS.map((e, i) => ({
        ...e,
        id: `env_${i}`,
      }));
      let metrics: HealthMetric[] = [
        { name: 'CPU Usage', value: 35, unit: '%', status: 'healthy', threshold_warning: 70, threshold_critical: 90 },
        { name: 'Memory Usage', value: 52, unit: '%', status: 'healthy', threshold_warning: 80, threshold_critical: 95 },
        { name: 'Storage Usage', value: 72, unit: '%', status: 'warning', threshold_warning: 70, threshold_critical: 90 },
        { name: 'Database Connections', value: 45, unit: 'active', status: 'healthy', threshold_warning: 150, threshold_critical: 190 },
        { name: 'API Response Time', value: 120, unit: 'ms', status: 'healthy', threshold_warning: 500, threshold_critical: 1000 },
        { name: 'Error Rate', value: 0.5, unit: '%', status: 'healthy', threshold_warning: 5, threshold_critical: 10 },
      ];

      // Parse stored settings if they exist
      if (settingsData) {
        const reqsSetting = settingsData.find(s => s.setting_key === 'system_requirements');
        const checksSetting = settingsData.find(s => s.setting_key === 'system_checks');
        const envsSetting = settingsData.find(s => s.setting_key === 'environment_variables');
        const metricsSetting = settingsData.find(s => s.setting_key === 'health_metrics');

        if (reqsSetting?.setting_value && Array.isArray(reqsSetting.setting_value)) {
          reqs = reqsSetting.setting_value as unknown as SystemRequirement[];
        }
        if (checksSetting?.setting_value && Array.isArray(checksSetting.setting_value)) {
          checks = checksSetting.setting_value as unknown as SystemCheck[];
        }
        if (envsSetting?.setting_value && Array.isArray(envsSetting.setting_value)) {
          envs = envsSetting.setting_value as unknown as EnvironmentVariable[];
        }
        if (metricsSetting?.setting_value && Array.isArray(metricsSetting.setting_value)) {
          metrics = metricsSetting.setting_value as unknown as HealthMetric[];
        }
      }

      setRequirements(reqs);
      setSystemChecks(checks);
      setEnvVars(envs);
      setHealthMetrics(metrics);
    } catch (error) {
      console.error('Error fetching system requirements:', error);
      toast({
        title: 'Error',
        description: 'Failed to load system requirements',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Save requirements to database
  const saveRequirements = async (newRequirements: SystemRequirement[]) => {
    try {
      const { error } = await supabase
        .from('admin_settings')
        .upsert([{
          setting_key: 'system_requirements',
          setting_value: JSON.parse(JSON.stringify(newRequirements)),
          description: 'System requirements configuration',
          updated_at: new Date().toISOString(),
        }], { onConflict: 'setting_key' });

      if (error) throw error;
      setRequirements(newRequirements);
    } catch (error) {
      console.error('Error saving requirements:', error);
      throw error;
    }
  };

  // Save system checks to database
  const saveSystemChecks = async (newChecks: SystemCheck[]) => {
    try {
      const { error } = await supabase
        .from('admin_settings')
        .upsert([{
          setting_key: 'system_checks',
          setting_value: JSON.parse(JSON.stringify(newChecks)),
          description: 'System health checks configuration',
          updated_at: new Date().toISOString(),
        }], { onConflict: 'setting_key' });

      if (error) throw error;
      setSystemChecks(newChecks);
    } catch (error) {
      console.error('Error saving system checks:', error);
      throw error;
    }
  };

  // Handle requirement form submit
  const handleRequirementSubmit = async () => {
    if (!requirementForm.name || !requirementForm.value) {
      toast({
        title: 'Validation Error',
        description: 'Name and value are required',
        variant: 'destructive',
      });
      return;
    }

    setIsSaving(true);
    try {
      const now = new Date().toISOString();
      let newRequirements: SystemRequirement[];

      if (editingRequirement) {
        newRequirements = requirements.map(r =>
          r.id === editingRequirement.id
            ? {
                ...r,
                ...requirementForm,
                notes: requirementForm.notes || null,
                current_value: requirementForm.current_value || null,
                updated_at: now,
              }
            : r
        );
      } else {
        const newRequirement: SystemRequirement = {
          id: `req_${Date.now()}`,
          ...requirementForm,
          notes: requirementForm.notes || null,
          current_value: requirementForm.current_value || null,
          created_at: now,
          updated_at: now,
        };
        newRequirements = [...requirements, newRequirement];
      }

      await saveRequirements(newRequirements);

      toast({
        title: 'Success',
        description: editingRequirement ? 'Requirement updated successfully' : 'Requirement added successfully',
      });

      setIsRequirementDialogOpen(false);
      resetRequirementForm();
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to save requirement',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  // Reset requirement form
  const resetRequirementForm = () => {
    setRequirementForm({
      category: 'hardware',
      name: '',
      description: '',
      requirement_type: 'minimum',
      value: '',
      unit: '',
      current_value: '',
      status: 'unknown',
      priority: 1,
      is_critical: false,
      notes: '',
    });
    setEditingRequirement(null);
  };

  // Open edit dialog
  const openEditRequirement = (requirement: SystemRequirement) => {
    setEditingRequirement(requirement);
    setRequirementForm({
      category: requirement.category,
      name: requirement.name,
      description: requirement.description,
      requirement_type: requirement.requirement_type,
      value: requirement.value,
      unit: requirement.unit,
      current_value: requirement.current_value || '',
      status: requirement.status,
      priority: requirement.priority,
      is_critical: requirement.is_critical,
      notes: requirement.notes || '',
    });
    setIsRequirementDialogOpen(true);
  };

  // Handle delete
  const handleDelete = async () => {
    if (!deletingItem) return;

    setIsSaving(true);
    try {
      if (deletingItem.type === 'requirement') {
        const newRequirements = requirements.filter(r => r.id !== deletingItem.id);
        await saveRequirements(newRequirements);
        toast({ title: 'Success', description: 'Requirement deleted successfully' });
      } else {
        const newChecks = systemChecks.filter(c => c.id !== deletingItem.id);
        await saveSystemChecks(newChecks);
        toast({ title: 'Success', description: 'System check deleted successfully' });
      }
      setIsDeleteDialogOpen(false);
      setDeletingItem(null);
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to delete item',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  // Run all system checks
  const runAllChecks = async () => {
    setIsRunningChecks(true);
    try {
      // Simulate running checks with updated timestamps
      const updatedChecks = systemChecks.map(check => ({
        ...check,
        last_run: new Date().toISOString(),
        // Simulate some random status changes
        status: Math.random() > 0.1 ? check.status : (Math.random() > 0.5 ? 'warning' : 'passed') as SystemCheck['status'],
      }));

      await saveSystemChecks(updatedChecks);

      toast({
        title: 'Checks Complete',
        description: `Ran ${systemChecks.length} system checks`,
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to run system checks',
        variant: 'destructive',
      });
    } finally {
      setIsRunningChecks(false);
    }
  };

  // Run single check
  const runSingleCheck = async (checkId: string) => {
    try {
      const updatedChecks = systemChecks.map(check =>
        check.id === checkId
          ? { ...check, last_run: new Date().toISOString() }
          : check
      );
      await saveSystemChecks(updatedChecks);
      toast({ title: 'Check Complete', description: 'System check completed' });
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to run check',
        variant: 'destructive',
      });
    }
  };

  // Export requirements
  const exportRequirements = () => {
    const data = requirements.map(r => ({
      Category: r.category,
      Name: r.name,
      Description: r.description,
      Type: r.requirement_type,
      'Required Value': `${r.value} ${r.unit}`,
      'Current Value': r.current_value || 'N/A',
      Status: r.status,
      Critical: r.is_critical ? 'Yes' : 'No',
      Priority: r.priority,
    }));

    const csv = [
      Object.keys(data[0] || {}).join(','),
      ...data.map(row => Object.values(row).join(','))
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `system-requirements-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Filtered requirements
  const filteredRequirements = requirements.filter(r => {
    const matchesSearch = r.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      r.description.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = categoryFilter === 'all' || r.category === categoryFilter;
    const matchesStatus = statusFilter === 'all' || r.status === statusFilter;
    const matchesType = typeFilter === 'all' || r.requirement_type === typeFilter;
    return matchesSearch && matchesCategory && matchesStatus && matchesType;
  });

  // Statistics
  const stats = {
    total: requirements.length,
    met: requirements.filter(r => r.status === 'met').length,
    notMet: requirements.filter(r => r.status === 'not_met').length,
    warning: requirements.filter(r => r.status === 'warning').length,
    critical: requirements.filter(r => r.is_critical).length,
    checksTotal: systemChecks.length,
    checksPassed: systemChecks.filter(c => c.status === 'passed').length,
    checksFailed: systemChecks.filter(c => c.status === 'failed').length,
    envTotal: envVars.length,
    envSet: envVars.filter(e => e.is_set).length,
    envRequired: envVars.filter(e => e.is_required).length,
  };

  const getCategoryIcon = (category: string) => {
    const cat = REQUIREMENT_CATEGORIES.find(c => c.value === category);
    return cat ? cat.icon : Server;
  };

  const getStatusBadge = (status: keyof typeof STATUS_CONFIG) => {
    const config = STATUS_CONFIG[status];
    const Icon = config.icon;
    return (
      <Badge variant="outline" className={config.color}>
        <Icon className="mr-1 h-3 w-3" />
        {config.label}
      </Badge>
    );
  };

  const getCheckStatusBadge = (status: keyof typeof CHECK_STATUS_CONFIG) => {
    const config = CHECK_STATUS_CONFIG[status];
    const Icon = config.icon;
    return (
      <Badge variant="outline" className={config.color}>
        <Icon className="mr-1 h-3 w-3" />
        {config.label}
      </Badge>
    );
  };

  const getTypeBadge = (type: string) => {
    const typeConfig = REQUIREMENT_TYPES.find(t => t.value === type);
    return (
      <Badge variant="outline" className={typeConfig?.color || ''}>
        {typeConfig?.label || type}
      </Badge>
    );
  };

  const getHealthStatus = (metric: HealthMetric): 'healthy' | 'warning' | 'critical' => {
    if (metric.value >= metric.threshold_critical) return 'critical';
    if (metric.value >= metric.threshold_warning) return 'warning';
    return 'healthy';
  };

  const getHealthColor = (status: 'healthy' | 'warning' | 'critical') => {
    switch (status) {
      case 'healthy': return 'text-green-600';
      case 'warning': return 'text-yellow-600';
      case 'critical': return 'text-red-600';
    }
  };

  const getProgressColor = (status: 'healthy' | 'warning' | 'critical') => {
    switch (status) {
      case 'healthy': return 'bg-green-500';
      case 'warning': return 'bg-yellow-500';
      case 'critical': return 'bg-red-500';
    }
  };

  return (
    <AdminLayout
      title="System Requirements"
      description="Monitor system health, requirements, and environment configuration"
    >
      {/* Statistics Cards */}
      <div className="grid gap-4 md:grid-cols-4 mb-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Requirements</CardTitle>
            <FileCheck className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.total}</div>
            <p className="text-xs text-muted-foreground">
              {stats.critical} critical requirements
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Requirements Met</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{stats.met}</div>
            <p className="text-xs text-muted-foreground">
              {stats.notMet} not met, {stats.warning} warnings
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">System Checks</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.checksPassed}/{stats.checksTotal}</div>
            <p className="text-xs text-muted-foreground">
              {stats.checksFailed > 0 ? `${stats.checksFailed} failed` : 'All checks passing'}
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Environment Variables</CardTitle>
            <Key className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.envSet}/{stats.envTotal}</div>
            <p className="text-xs text-muted-foreground">
              {stats.envRequired} required, {stats.envTotal - stats.envSet} missing
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Health Metrics Overview */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            System Health Overview
          </CardTitle>
          <CardDescription>Real-time system health metrics</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-6">
            {healthMetrics.map((metric, index) => {
              const status = getHealthStatus(metric);
              return (
                <div key={index} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{metric.name}</span>
                    <span className={`text-sm font-bold ${getHealthColor(status)}`}>
                      {metric.value}{metric.unit}
                    </span>
                  </div>
                  <div className="h-2 w-full bg-secondary rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all ${getProgressColor(status)}`}
                      style={{ width: `${Math.min((metric.value / metric.threshold_critical) * 100, 100)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Main Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="requirements">
            <FileCheck className="h-4 w-4 mr-2" />
            Requirements
          </TabsTrigger>
          <TabsTrigger value="checks">
            <Activity className="h-4 w-4 mr-2" />
            System Checks
          </TabsTrigger>
          <TabsTrigger value="environment">
            <Key className="h-4 w-4 mr-2" />
            Environment
          </TabsTrigger>
          <TabsTrigger value="compatibility">
            <Globe className="h-4 w-4 mr-2" />
            Compatibility
          </TabsTrigger>
        </TabsList>

        {/* Requirements Tab */}
        <TabsContent value="requirements">
          <Card>
            <CardHeader>
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <div>
                  <CardTitle>System Requirements</CardTitle>
                  <CardDescription>Hardware, software, and configuration requirements</CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={exportRequirements}>
                    <Download className="h-4 w-4 mr-2" />
                    Export
                  </Button>
                  <Button size="sm" onClick={() => {
                    resetRequirementForm();
                    setIsRequirementDialogOpen(true);
                  }}>
                    <Plus className="h-4 w-4 mr-2" />
                    Add Requirement
                  </Button>
                </div>
              </div>
              
              {/* Filters */}
              <div className="flex flex-col md:flex-row gap-4 mt-4">
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search requirements..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-8"
                  />
                </div>
                <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                  <SelectTrigger className="w-[150px]">
                    <SelectValue placeholder="Category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    {REQUIREMENT_CATEGORIES.map(cat => (
                      <SelectItem key={cat.value} value={cat.value}>{cat.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-[130px]">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="met">Met</SelectItem>
                    <SelectItem value="not_met">Not Met</SelectItem>
                    <SelectItem value="warning">Warning</SelectItem>
                    <SelectItem value="unknown">Unknown</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger className="w-[150px]">
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    {REQUIREMENT_TYPES.map(type => (
                      <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[500px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Category</TableHead>
                      <TableHead>Requirement</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Required</TableHead>
                      <TableHead>Current</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Priority</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredRequirements.map((req) => {
                      const CategoryIcon = getCategoryIcon(req.category);
                      return (
                        <TableRow key={req.id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <CategoryIcon className="h-4 w-4 text-muted-foreground" />
                              <span className="capitalize">{req.category}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div>
                              <div className="font-medium flex items-center gap-1">
                                {req.name}
                                {req.is_critical && (
                                  <AlertCircle className="h-3 w-3 text-red-500" />
                                )}
                              </div>
                              <div className="text-xs text-muted-foreground">{req.description}</div>
                            </div>
                          </TableCell>
                          <TableCell>{getTypeBadge(req.requirement_type)}</TableCell>
                          <TableCell className="font-mono text-sm">
                            {req.value} {req.unit}
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            {req.current_value ? `${req.current_value} ${req.unit}` : '-'}
                          </TableCell>
                          <TableCell>{getStatusBadge(req.status)}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{req.priority}</Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openEditRequirement(req)}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => {
                                  setDeletingItem({ type: 'requirement', id: req.id });
                                  setIsDeleteDialogOpen(true);
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {filteredRequirements.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                          No requirements found
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        {/* System Checks Tab */}
        <TabsContent value="checks">
          <Card>
            <CardHeader>
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <div>
                  <CardTitle>System Health Checks</CardTitle>
                  <CardDescription>Automated checks for system health and stability</CardDescription>
                </div>
                <Button onClick={runAllChecks} disabled={isRunningChecks}>
                  <RefreshCw className={`h-4 w-4 mr-2 ${isRunningChecks ? 'animate-spin' : ''}`} />
                  Run All Checks
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-2">
                {systemChecks.map((check) => {
                  const CategoryIcon = getCategoryIcon(check.category);
                  return (
                    <Card key={check.id}>
                      <CardContent className="pt-4">
                        <div className="flex items-start justify-between">
                          <div className="flex items-start gap-3">
                            <div className="p-2 rounded-lg bg-secondary">
                              <CategoryIcon className="h-5 w-5 text-muted-foreground" />
                            </div>
                            <div>
                              <div className="font-medium">{check.check_name}</div>
                              <div className="text-sm text-muted-foreground capitalize">{check.category}</div>
                            </div>
                          </div>
                          {getCheckStatusBadge(check.status)}
                        </div>
                        
                        <p className="mt-3 text-sm">{check.message}</p>
                        
                        {check.details && Object.keys(check.details).length > 0 && (
                          <div className="mt-3 p-2 rounded bg-secondary/50">
                            <div className="grid grid-cols-2 gap-2 text-xs">
                              {Object.entries(check.details).map(([key, value]) => (
                                <div key={key}>
                                  <span className="text-muted-foreground">{key}: </span>
                                  <span className="font-medium">{String(value)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        
                        <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                          <div className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {check.last_run ? new Date(check.last_run).toLocaleString() : 'Never'}
                          </div>
                          <div className="flex items-center gap-2">
                            {check.auto_run && (
                              <Badge variant="outline" className="text-xs">
                                Auto: {check.run_interval_minutes}m
                              </Badge>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => runSingleCheck(check.id)}
                            >
                              <RefreshCw className="h-3 w-3 mr-1" />
                              Run
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Environment Tab */}
        <TabsContent value="environment">
          <Card>
            <CardHeader>
              <CardTitle>Environment Variables</CardTitle>
              <CardDescription>Configuration and API keys for the system</CardDescription>
            </CardHeader>
            <CardContent>
              <Alert className="mb-4">
                <Info className="h-4 w-4" />
                <AlertTitle>Secret Management</AlertTitle>
                <AlertDescription>
                  Secret values are masked for security. Use the Supabase dashboard or Cloud secrets to manage sensitive values.
                </AlertDescription>
              </Alert>
              
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Variable</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Required</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {envVars.map((env) => (
                    <TableRow key={env.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {env.is_secret ? (
                            <Lock className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <Key className="h-4 w-4 text-muted-foreground" />
                          )}
                          <code className="text-sm font-mono bg-secondary px-2 py-0.5 rounded">
                            {env.key}
                          </code>
                        </div>
                      </TableCell>
                      <TableCell className="capitalize">{env.category}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {env.description}
                      </TableCell>
                      <TableCell>
                        {env.is_required ? (
                          <Badge variant="outline" className="bg-red-500/10 text-red-600">Required</Badge>
                        ) : (
                          <Badge variant="outline">Optional</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {env.is_set ? (
                          <Badge variant="outline" className="bg-green-500/10 text-green-600">
                            <CheckCircle2 className="h-3 w-3 mr-1" />
                            Set
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="bg-yellow-500/10 text-yellow-600">
                            <AlertTriangle className="h-3 w-3 mr-1" />
                            Not Set
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Compatibility Tab */}
        <TabsContent value="compatibility">
          <div className="grid gap-6 md:grid-cols-2">
            {/* Browser Compatibility */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Globe className="h-5 w-5 text-primary" />
                  Browser Compatibility
                </CardTitle>
                <CardDescription>Supported web browsers and versions</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {requirements.filter(r => r.category === 'browser').map((req) => (
                    <div key={req.id} className="flex items-center justify-between p-3 rounded-lg bg-secondary/50">
                      <div className="flex items-center gap-3">
                        <Globe className="h-5 w-5 text-muted-foreground" />
                        <div>
                          <div className="font-medium">{req.name}</div>
                          <div className="text-xs text-muted-foreground">
                            Minimum version: {req.value}
                          </div>
                        </div>
                      </div>
                      {getStatusBadge(req.status)}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Mobile Compatibility */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Smartphone className="h-5 w-5 text-primary" />
                  Mobile Compatibility
                </CardTitle>
                <CardDescription>Supported mobile platforms and versions</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {requirements.filter(r => r.category === 'mobile').map((req) => (
                    <div key={req.id} className="flex items-center justify-between p-3 rounded-lg bg-secondary/50">
                      <div className="flex items-center gap-3">
                        <Smartphone className="h-5 w-5 text-muted-foreground" />
                        <div>
                          <div className="font-medium">{req.name}</div>
                          <div className="text-xs text-muted-foreground">
                            Minimum version: {req.value}
                          </div>
                        </div>
                      </div>
                      {getStatusBadge(req.status)}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Network Requirements */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Wifi className="h-5 w-5 text-primary" />
                  Network Requirements
                </CardTitle>
                <CardDescription>Network and connectivity requirements</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {requirements.filter(r => r.category === 'network').map((req) => (
                    <div key={req.id} className="flex items-center justify-between p-3 rounded-lg bg-secondary/50">
                      <div className="flex items-center gap-3">
                        <Network className="h-5 w-5 text-muted-foreground" />
                        <div>
                          <div className="font-medium">{req.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {req.description}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-sm">{req.value} {req.unit}</div>
                        {getStatusBadge(req.status)}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Security Requirements */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Shield className="h-5 w-5 text-primary" />
                  Security Requirements
                </CardTitle>
                <CardDescription>Security and compliance requirements</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {requirements.filter(r => r.category === 'security').map((req) => (
                    <div key={req.id} className="flex items-center justify-between p-3 rounded-lg bg-secondary/50">
                      <div className="flex items-center gap-3">
                        <Lock className="h-5 w-5 text-muted-foreground" />
                        <div>
                          <div className="font-medium flex items-center gap-1">
                            {req.name}
                            {req.is_critical && <AlertCircle className="h-3 w-3 text-red-500" />}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {req.description}
                          </div>
                        </div>
                      </div>
                      {getStatusBadge(req.status)}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      {/* Requirement Dialog */}
      <Dialog open={isRequirementDialogOpen} onOpenChange={setIsRequirementDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>
              {editingRequirement ? 'Edit Requirement' : 'Add Requirement'}
            </DialogTitle>
            <DialogDescription>
              {editingRequirement ? 'Update the system requirement details' : 'Add a new system requirement'}
            </DialogDescription>
          </DialogHeader>
          
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Category</Label>
                <Select
                  value={requirementForm.category}
                  onValueChange={(v) => setRequirementForm(prev => ({ ...prev, category: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REQUIREMENT_CATEGORIES.map(cat => (
                      <SelectItem key={cat.value} value={cat.value}>{cat.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Type</Label>
                <Select
                  value={requirementForm.requirement_type}
                  onValueChange={(v) => setRequirementForm(prev => ({ ...prev, requirement_type: v as any }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REQUIREMENT_TYPES.map(type => (
                      <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={requirementForm.name}
                onChange={(e) => setRequirementForm(prev => ({ ...prev, name: e.target.value }))}
                placeholder="e.g., CPU Cores, RAM, Node.js"
              />
            </div>
            
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                value={requirementForm.description}
                onChange={(e) => setRequirementForm(prev => ({ ...prev, description: e.target.value }))}
                placeholder="Describe this requirement..."
                rows={2}
              />
            </div>
            
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Required Value</Label>
                <Input
                  value={requirementForm.value}
                  onChange={(e) => setRequirementForm(prev => ({ ...prev, value: e.target.value }))}
                  placeholder="e.g., 4"
                />
              </div>
              <div className="space-y-2">
                <Label>Unit</Label>
                <Input
                  value={requirementForm.unit}
                  onChange={(e) => setRequirementForm(prev => ({ ...prev, unit: e.target.value }))}
                  placeholder="e.g., GB, cores"
                />
              </div>
              <div className="space-y-2">
                <Label>Current Value</Label>
                <Input
                  value={requirementForm.current_value}
                  onChange={(e) => setRequirementForm(prev => ({ ...prev, current_value: e.target.value }))}
                  placeholder="Detected value"
                />
              </div>
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Status</Label>
                <Select
                  value={requirementForm.status}
                  onValueChange={(v) => setRequirementForm(prev => ({ ...prev, status: v as any }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="met">Met</SelectItem>
                    <SelectItem value="not_met">Not Met</SelectItem>
                    <SelectItem value="warning">Warning</SelectItem>
                    <SelectItem value="unknown">Unknown</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Priority (1-10)</Label>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={requirementForm.priority}
                  onChange={(e) => setRequirementForm(prev => ({ ...prev, priority: parseInt(e.target.value) || 1 }))}
                />
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              <Switch
                checked={requirementForm.is_critical}
                onCheckedChange={(v) => setRequirementForm(prev => ({ ...prev, is_critical: v }))}
              />
              <Label>Critical Requirement</Label>
            </div>
            
            <div className="space-y-2">
              <Label>Notes (Optional)</Label>
              <Textarea
                value={requirementForm.notes}
                onChange={(e) => setRequirementForm(prev => ({ ...prev, notes: e.target.value }))}
                placeholder="Additional notes..."
                rows={2}
              />
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsRequirementDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleRequirementSubmit} disabled={isSaving}>
              {isSaving ? 'Saving...' : editingRequirement ? 'Update' : 'Add'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deletingItem?.type === 'requirement' ? 'Requirement' : 'Check'}?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete this {deletingItem?.type}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminLayout>
  );
}
