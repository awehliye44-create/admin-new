import { useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  Settings, 
  CreditCard, 
  Percent, 
  Clock,
  FileText,
  Bell,
  Shield,
  Save,
  RefreshCw,
  Building2,
  DollarSign,
  Users,
  Mail
} from 'lucide-react';

interface CorporateSettingsData {
  billing: {
    default_payment_terms: string;
    invoice_prefix: string;
    invoice_due_reminder_days: number;
    auto_generate_invoices: boolean;
    invoice_generation_day: number;
    tax_rate: number;
    tax_name: string;
    currency: string;
  };
  discounts: {
    enable_volume_discounts: boolean;
    volume_tiers: { min_trips: number; discount: number }[];
    enable_loyalty_discounts: boolean;
    loyalty_months: number;
    loyalty_discount: number;
    max_discount_percentage: number;
  };
  onboarding: {
    require_tax_id: boolean;
    require_billing_address: boolean;
    require_company_registration: boolean;
    auto_approve_accounts: boolean;
    min_employee_count: number;
    welcome_email_template: string;
  };
  notifications: {
    send_invoice_emails: boolean;
    send_payment_reminders: boolean;
    reminder_days_before_due: number[];
    send_usage_reports: boolean;
    usage_report_frequency: string;
    admin_notification_email: string;
  };
  limits: {
    default_credit_limit: number;
    max_credit_limit: number;
    default_monthly_budget: number;
    enable_budget_alerts: boolean;
    budget_alert_threshold: number;
  };
}

const defaultSettings: CorporateSettingsData = {
  billing: {
    default_payment_terms: 'net30',
    invoice_prefix: 'INV',
    invoice_due_reminder_days: 7,
    auto_generate_invoices: true,
    invoice_generation_day: 1,
    tax_rate: 10,
    tax_name: 'VAT',
    currency: 'USD',
  },
  discounts: {
    enable_volume_discounts: true,
    volume_tiers: [
      { min_trips: 50, discount: 5 },
      { min_trips: 100, discount: 10 },
      { min_trips: 250, discount: 15 },
      { min_trips: 500, discount: 20 },
    ],
    enable_loyalty_discounts: true,
    loyalty_months: 12,
    loyalty_discount: 5,
    max_discount_percentage: 30,
  },
  onboarding: {
    require_tax_id: true,
    require_billing_address: true,
    require_company_registration: false,
    auto_approve_accounts: false,
    min_employee_count: 5,
    welcome_email_template: 'Welcome to our corporate program! Your account has been approved.',
  },
  notifications: {
    send_invoice_emails: true,
    send_payment_reminders: true,
    reminder_days_before_due: [7, 3, 1],
    send_usage_reports: true,
    usage_report_frequency: 'monthly',
    admin_notification_email: 'admin@company.com',
  },
  limits: {
    default_credit_limit: 10000,
    max_credit_limit: 100000,
    default_monthly_budget: 5000,
    enable_budget_alerts: true,
    budget_alert_threshold: 80,
  },
};

export default function CorporateSettings() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('billing');

  const { data: settings = defaultSettings, isLoading } = useQuery({
    queryKey: ['corporate-settings'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('*')
        .eq('setting_key', 'corporate_settings_config')
        .maybeSingle();
      
      if (error) throw error;
      return (data?.setting_value as unknown as CorporateSettingsData) || defaultSettings;
    },
  });

  const [formData, setFormData] = useState<CorporateSettingsData>(settings);

  // Update form when data loads
  useState(() => {
    setFormData(settings);
  });

  const saveMutation = useMutation({
    mutationFn: async (newSettings: CorporateSettingsData) => {
      const { error } = await supabase
        .from('admin_settings')
        .upsert([{
          setting_key: 'corporate_settings_config',
          setting_value: JSON.parse(JSON.stringify(newSettings)),
          description: 'Corporate account settings configuration',
          updated_at: new Date().toISOString(),
        }], { onConflict: 'setting_key' });
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['corporate-settings'] });
      toast.success('Settings saved successfully');
    },
    onError: () => {
      toast.error('Failed to save settings');
    },
  });

  const handleSave = () => {
    saveMutation.mutate(formData);
  };

  const handleReset = () => {
    setFormData(defaultSettings);
    toast.info('Settings reset to defaults');
  };

  const updateBilling = (key: keyof CorporateSettingsData['billing'], value: any) => {
    setFormData(prev => ({
      ...prev,
      billing: { ...prev.billing, [key]: value }
    }));
  };

  const updateDiscounts = (key: keyof CorporateSettingsData['discounts'], value: any) => {
    setFormData(prev => ({
      ...prev,
      discounts: { ...prev.discounts, [key]: value }
    }));
  };

  const updateOnboarding = (key: keyof CorporateSettingsData['onboarding'], value: any) => {
    setFormData(prev => ({
      ...prev,
      onboarding: { ...prev.onboarding, [key]: value }
    }));
  };

  const updateNotifications = (key: keyof CorporateSettingsData['notifications'], value: any) => {
    setFormData(prev => ({
      ...prev,
      notifications: { ...prev.notifications, [key]: value }
    }));
  };

  const updateLimits = (key: keyof CorporateSettingsData['limits'], value: any) => {
    setFormData(prev => ({
      ...prev,
      limits: { ...prev.limits, [key]: value }
    }));
  };

  if (isLoading) {
    return (
      <AdminLayout title="Corporate Settings" description="Configure corporate settings">
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout 
      title="Corporate Settings" 
      description="Configure payment terms, discounts, and billing rules"
    >
      <div className="space-y-6">
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={handleReset}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Reset to Defaults
          </Button>
          <Button onClick={handleSave} disabled={saveMutation.isPending}>
            <Save className="h-4 w-4 mr-2" />
            {saveMutation.isPending ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="billing" className="flex items-center gap-2">
              <CreditCard className="h-4 w-4" />
              <span className="hidden sm:inline">Billing</span>
            </TabsTrigger>
            <TabsTrigger value="discounts" className="flex items-center gap-2">
              <Percent className="h-4 w-4" />
              <span className="hidden sm:inline">Discounts</span>
            </TabsTrigger>
            <TabsTrigger value="onboarding" className="flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              <span className="hidden sm:inline">Onboarding</span>
            </TabsTrigger>
            <TabsTrigger value="notifications" className="flex items-center gap-2">
              <Bell className="h-4 w-4" />
              <span className="hidden sm:inline">Notifications</span>
            </TabsTrigger>
            <TabsTrigger value="limits" className="flex items-center gap-2">
              <Shield className="h-4 w-4" />
              <span className="hidden sm:inline">Limits</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="billing" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Invoice Settings</CardTitle>
                <CardDescription>Configure how invoices are generated and processed</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="payment_terms">Default Payment Terms</Label>
                    <Select 
                      value={formData.billing.default_payment_terms} 
                      onValueChange={(value) => updateBilling('default_payment_terms', value)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="prepaid">Prepaid</SelectItem>
                        <SelectItem value="net7">Net 7</SelectItem>
                        <SelectItem value="net15">Net 15</SelectItem>
                        <SelectItem value="net30">Net 30</SelectItem>
                        <SelectItem value="net45">Net 45</SelectItem>
                        <SelectItem value="net60">Net 60</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="invoice_prefix">Invoice Prefix</Label>
                    <Input
                      id="invoice_prefix"
                      value={formData.billing.invoice_prefix}
                      onChange={(e) => updateBilling('invoice_prefix', e.target.value)}
                      placeholder="INV"
                    />
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="currency">Currency</Label>
                    <Select 
                      value={formData.billing.currency} 
                      onValueChange={(value) => updateBilling('currency', value)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="USD">USD ($)</SelectItem>
                        <SelectItem value="EUR">EUR (€)</SelectItem>
                        <SelectItem value="GBP">GBP (£)</SelectItem>
                        <SelectItem value="CAD">CAD ($)</SelectItem>
                        <SelectItem value="AUD">AUD ($)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="tax_name">Tax Name</Label>
                    <Input
                      id="tax_name"
                      value={formData.billing.tax_name}
                      onChange={(e) => updateBilling('tax_name', e.target.value)}
                      placeholder="VAT"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="tax_rate">Tax Rate (%)</Label>
                    <Input
                      id="tax_rate"
                      type="number"
                      min="0"
                      max="100"
                      value={formData.billing.tax_rate}
                      onChange={(e) => updateBilling('tax_rate', parseFloat(e.target.value) || 0)}
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between p-4 border rounded-lg">
                  <div className="space-y-0.5">
                    <Label>Auto-Generate Invoices</Label>
                    <p className="text-sm text-muted-foreground">Automatically generate invoices at the start of each billing period</p>
                  </div>
                  <Switch
                    checked={formData.billing.auto_generate_invoices}
                    onCheckedChange={(checked) => updateBilling('auto_generate_invoices', checked)}
                  />
                </div>

                {formData.billing.auto_generate_invoices && (
                  <div className="space-y-2">
                    <Label htmlFor="invoice_generation_day">Invoice Generation Day</Label>
                    <Select 
                      value={formData.billing.invoice_generation_day.toString()} 
                      onValueChange={(value) => updateBilling('invoice_generation_day', parseInt(value))}
                    >
                      <SelectTrigger className="w-[200px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[1, 5, 10, 15, 20, 25].map(day => (
                          <SelectItem key={day} value={day.toString()}>Day {day} of month</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="discounts" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Volume Discounts</CardTitle>
                <CardDescription>Automatic discounts based on trip volume</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between p-4 border rounded-lg">
                  <div className="space-y-0.5">
                    <Label>Enable Volume Discounts</Label>
                    <p className="text-sm text-muted-foreground">Apply automatic discounts based on monthly trip count</p>
                  </div>
                  <Switch
                    checked={formData.discounts.enable_volume_discounts}
                    onCheckedChange={(checked) => updateDiscounts('enable_volume_discounts', checked)}
                  />
                </div>

                {formData.discounts.enable_volume_discounts && (
                  <div className="space-y-2">
                    <Label>Volume Tiers</Label>
                    <div className="border rounded-lg overflow-hidden">
                      <table className="w-full">
                        <thead className="bg-muted">
                          <tr>
                            <th className="px-4 py-2 text-left text-sm font-medium">Minimum Trips</th>
                            <th className="px-4 py-2 text-left text-sm font-medium">Discount %</th>
                          </tr>
                        </thead>
                        <tbody>
                          {formData.discounts.volume_tiers.map((tier, index) => (
                            <tr key={index} className="border-t">
                              <td className="px-4 py-2">{tier.min_trips}+ trips</td>
                              <td className="px-4 py-2">{tier.discount}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Loyalty Discounts</CardTitle>
                <CardDescription>Reward long-term corporate clients</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between p-4 border rounded-lg">
                  <div className="space-y-0.5">
                    <Label>Enable Loyalty Discounts</Label>
                    <p className="text-sm text-muted-foreground">Additional discounts for long-term clients</p>
                  </div>
                  <Switch
                    checked={formData.discounts.enable_loyalty_discounts}
                    onCheckedChange={(checked) => updateDiscounts('enable_loyalty_discounts', checked)}
                  />
                </div>

                {formData.discounts.enable_loyalty_discounts && (
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="loyalty_months">Months Required</Label>
                      <Input
                        id="loyalty_months"
                        type="number"
                        min="1"
                        value={formData.discounts.loyalty_months}
                        onChange={(e) => updateDiscounts('loyalty_months', parseInt(e.target.value) || 12)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="loyalty_discount">Loyalty Discount (%)</Label>
                      <Input
                        id="loyalty_discount"
                        type="number"
                        min="0"
                        max="100"
                        value={formData.discounts.loyalty_discount}
                        onChange={(e) => updateDiscounts('loyalty_discount', parseFloat(e.target.value) || 0)}
                      />
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="max_discount">Maximum Total Discount (%)</Label>
                  <Input
                    id="max_discount"
                    type="number"
                    min="0"
                    max="100"
                    value={formData.discounts.max_discount_percentage}
                    onChange={(e) => updateDiscounts('max_discount_percentage', parseFloat(e.target.value) || 0)}
                    className="w-[200px]"
                  />
                  <p className="text-sm text-muted-foreground">Combined discounts will not exceed this percentage</p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="onboarding" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Account Requirements</CardTitle>
                <CardDescription>Required information for new corporate accounts</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-4 border rounded-lg">
                    <div className="space-y-0.5">
                      <Label>Require Tax ID</Label>
                      <p className="text-sm text-muted-foreground">Company must provide tax identification number</p>
                    </div>
                    <Switch
                      checked={formData.onboarding.require_tax_id}
                      onCheckedChange={(checked) => updateOnboarding('require_tax_id', checked)}
                    />
                  </div>

                  <div className="flex items-center justify-between p-4 border rounded-lg">
                    <div className="space-y-0.5">
                      <Label>Require Billing Address</Label>
                      <p className="text-sm text-muted-foreground">Company must provide a billing address</p>
                    </div>
                    <Switch
                      checked={formData.onboarding.require_billing_address}
                      onCheckedChange={(checked) => updateOnboarding('require_billing_address', checked)}
                    />
                  </div>

                  <div className="flex items-center justify-between p-4 border rounded-lg">
                    <div className="space-y-0.5">
                      <Label>Require Company Registration</Label>
                      <p className="text-sm text-muted-foreground">Company must provide registration documents</p>
                    </div>
                    <Switch
                      checked={formData.onboarding.require_company_registration}
                      onCheckedChange={(checked) => updateOnboarding('require_company_registration', checked)}
                    />
                  </div>

                  <div className="flex items-center justify-between p-4 border rounded-lg">
                    <div className="space-y-0.5">
                      <Label>Auto-Approve Accounts</Label>
                      <p className="text-sm text-muted-foreground">Automatically approve new account requests</p>
                    </div>
                    <Switch
                      checked={formData.onboarding.auto_approve_accounts}
                      onCheckedChange={(checked) => updateOnboarding('auto_approve_accounts', checked)}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="min_employees">Minimum Employee Count</Label>
                  <Input
                    id="min_employees"
                    type="number"
                    min="1"
                    value={formData.onboarding.min_employee_count}
                    onChange={(e) => updateOnboarding('min_employee_count', parseInt(e.target.value) || 1)}
                    className="w-[200px]"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="welcome_email">Welcome Email Template</Label>
                  <Textarea
                    id="welcome_email"
                    value={formData.onboarding.welcome_email_template}
                    onChange={(e) => updateOnboarding('welcome_email_template', e.target.value)}
                    rows={4}
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="notifications" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Email Notifications</CardTitle>
                <CardDescription>Configure automated email notifications</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between p-4 border rounded-lg">
                  <div className="space-y-0.5">
                    <Label>Send Invoice Emails</Label>
                    <p className="text-sm text-muted-foreground">Email invoices to billing contacts automatically</p>
                  </div>
                  <Switch
                    checked={formData.notifications.send_invoice_emails}
                    onCheckedChange={(checked) => updateNotifications('send_invoice_emails', checked)}
                  />
                </div>

                <div className="flex items-center justify-between p-4 border rounded-lg">
                  <div className="space-y-0.5">
                    <Label>Send Payment Reminders</Label>
                    <p className="text-sm text-muted-foreground">Remind clients about upcoming and overdue payments</p>
                  </div>
                  <Switch
                    checked={formData.notifications.send_payment_reminders}
                    onCheckedChange={(checked) => updateNotifications('send_payment_reminders', checked)}
                  />
                </div>

                <div className="flex items-center justify-between p-4 border rounded-lg">
                  <div className="space-y-0.5">
                    <Label>Send Usage Reports</Label>
                    <p className="text-sm text-muted-foreground">Send periodic usage reports to corporate contacts</p>
                  </div>
                  <Switch
                    checked={formData.notifications.send_usage_reports}
                    onCheckedChange={(checked) => updateNotifications('send_usage_reports', checked)}
                  />
                </div>

                {formData.notifications.send_usage_reports && (
                  <div className="space-y-2">
                    <Label htmlFor="report_frequency">Usage Report Frequency</Label>
                    <Select 
                      value={formData.notifications.usage_report_frequency} 
                      onValueChange={(value) => updateNotifications('usage_report_frequency', value)}
                    >
                      <SelectTrigger className="w-[200px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="weekly">Weekly</SelectItem>
                        <SelectItem value="biweekly">Bi-weekly</SelectItem>
                        <SelectItem value="monthly">Monthly</SelectItem>
                        <SelectItem value="quarterly">Quarterly</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="admin_email">Admin Notification Email</Label>
                  <Input
                    id="admin_email"
                    type="email"
                    value={formData.notifications.admin_notification_email}
                    onChange={(e) => updateNotifications('admin_notification_email', e.target.value)}
                    placeholder="admin@company.com"
                    className="max-w-md"
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="limits" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Credit & Budget Limits</CardTitle>
                <CardDescription>Default limits for new corporate accounts</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="default_credit">Default Credit Limit ($)</Label>
                    <Input
                      id="default_credit"
                      type="number"
                      min="0"
                      value={formData.limits.default_credit_limit}
                      onChange={(e) => updateLimits('default_credit_limit', parseInt(e.target.value) || 0)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="max_credit">Maximum Credit Limit ($)</Label>
                    <Input
                      id="max_credit"
                      type="number"
                      min="0"
                      value={formData.limits.max_credit_limit}
                      onChange={(e) => updateLimits('max_credit_limit', parseInt(e.target.value) || 0)}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="default_budget">Default Monthly Budget ($)</Label>
                  <Input
                    id="default_budget"
                    type="number"
                    min="0"
                    value={formData.limits.default_monthly_budget}
                    onChange={(e) => updateLimits('default_monthly_budget', parseInt(e.target.value) || 0)}
                    className="w-[250px]"
                  />
                </div>

                <div className="flex items-center justify-between p-4 border rounded-lg">
                  <div className="space-y-0.5">
                    <Label>Enable Budget Alerts</Label>
                    <p className="text-sm text-muted-foreground">Notify when accounts approach budget limits</p>
                  </div>
                  <Switch
                    checked={formData.limits.enable_budget_alerts}
                    onCheckedChange={(checked) => updateLimits('enable_budget_alerts', checked)}
                  />
                </div>

                {formData.limits.enable_budget_alerts && (
                  <div className="space-y-2">
                    <Label htmlFor="alert_threshold">Alert Threshold (%)</Label>
                    <Input
                      id="alert_threshold"
                      type="number"
                      min="1"
                      max="100"
                      value={formData.limits.budget_alert_threshold}
                      onChange={(e) => updateLimits('budget_alert_threshold', parseInt(e.target.value) || 80)}
                      className="w-[200px]"
                    />
                    <p className="text-sm text-muted-foreground">Alert when budget usage reaches this percentage</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AdminLayout>
  );
}
