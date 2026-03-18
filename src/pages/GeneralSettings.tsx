import { useState, useEffect } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  Building2, 
  Palette, 
  Globe, 
  Mail, 
  Phone, 
  MapPin,
  Upload,
  Save,
  RefreshCw,
  Image,
  Type,
  Sun,
  Moon,
  Monitor,
  Languages,
  Clock,
  DollarSign,
  Ruler,
  Check,
  X,
  Eye,
  Trash2,
  Shield
} from 'lucide-react';

interface CompanyInfo {
  name: string;
  legalName: string;
  email: string;
  phone: string;
  website: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  taxId: string;
  registrationNumber: string;
}

interface BrandingSettings {
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  logoUrl: string;
  faviconUrl: string;
  appIconUrl: string;
  splashScreenUrl: string;
  tagline: string;
  fontFamily: string;
  borderRadius: string;
}

interface LocalizationSettings {
  defaultLanguage: string;
  supportedLanguages: string[];
  defaultTimezone: string;
  dateFormat: string;
  timeFormat: string;
}

interface AppSettings {
  appName: string;
  appVersion: string;
  maintenanceMode: boolean;
  maintenanceMessage: string;
  allowRegistration: boolean;
  requireEmailVerification: boolean;
  requirePhoneVerification: boolean;
  termsUrl: string;
  privacyUrl: string;
  supportEmail: string;
  supportPhone: string;
  socialLinks: {
    facebook: string;
    twitter: string;
    instagram: string;
    linkedin: string;
  };
}

const defaultCompanyInfo: CompanyInfo = {
  name: 'OneCab',
  legalName: 'OneCab Technologies Inc.',
  email: 'contact@onecab.com',
  phone: '+1 (555) 123-4567',
  website: 'https://onecab.com',
  address: '123 Main Street',
  city: 'San Francisco',
  state: 'California',
  zipCode: '94102',
  country: 'United States',
  taxId: 'XX-XXXXXXX',
  registrationNumber: 'REG-123456',
};

const defaultBrandingSettings: BrandingSettings = {
  primaryColor: '#6366f1',
  secondaryColor: '#8b5cf6',
  accentColor: '#f59e0b',
  logoUrl: '',
  faviconUrl: '',
  appIconUrl: '',
  splashScreenUrl: '',
  tagline: 'Your ride, your way',
  fontFamily: 'Inter',
  borderRadius: 'md',
};

const defaultLocalization: LocalizationSettings = {
  defaultLanguage: 'en',
  supportedLanguages: ['en', 'es', 'fr', 'de', 'pt'],
  defaultTimezone: 'America/New_York',
  dateFormat: 'MM/DD/YYYY',
  timeFormat: '12h',
};

const defaultAppSettings: AppSettings = {
  appName: 'OneCab',
  appVersion: '1.0.0',
  maintenanceMode: false,
  maintenanceMessage: 'We are currently performing scheduled maintenance. Please check back soon.',
  allowRegistration: true,
  requireEmailVerification: true,
  requirePhoneVerification: false,
  termsUrl: '/terms',
  privacyUrl: '/privacy',
  supportEmail: 'support@onecab.com',
  supportPhone: '+1 (555) 987-6543',
  socialLinks: {
    facebook: 'https://facebook.com/onecab',
    twitter: 'https://twitter.com/onecab',
    instagram: 'https://instagram.com/onecab',
    linkedin: 'https://linkedin.com/company/onecab',
  },
};

const languages = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hi', name: 'Hindi' },
];

const timezones = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Dubai',
  'Australia/Sydney',
];

const currencies = [
  { code: 'USD', symbol: '$', name: 'US Dollar' },
  { code: 'EUR', symbol: '€', name: 'Euro' },
  { code: 'GBP', symbol: '£', name: 'British Pound' },
  { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar' },
  { code: 'AUD', symbol: 'A$', name: 'Australian Dollar' },
  { code: 'JPY', symbol: '¥', name: 'Japanese Yen' },
  { code: 'INR', symbol: '₹', name: 'Indian Rupee' },
  { code: 'MXN', symbol: 'MX$', name: 'Mexican Peso' },
];

const fonts = [
  'Inter',
  'Roboto',
  'Open Sans',
  'Lato',
  'Montserrat',
  'Poppins',
  'Source Sans Pro',
  'Nunito',
];

export default function GeneralSettings() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('company');
  const [companyInfo, setCompanyInfo] = useState<CompanyInfo>(defaultCompanyInfo);
  const [branding, setBranding] = useState<BrandingSettings>(defaultBrandingSettings);
  const [localization, setLocalization] = useState<LocalizationSettings>(defaultLocalization);
  const [appSettings, setAppSettings] = useState<AppSettings>(defaultAppSettings);
  const [hasChanges, setHasChanges] = useState(false);

  // Fetch settings from database
  const { data: savedSettings, isLoading } = useQuery({
    queryKey: ['general-settings'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_settings')
        .select('*')
        .in('setting_key', ['company_info', 'branding_settings', 'localization_settings', 'app_settings']);
      
      if (error) throw error;
      
      const settings: Record<string, any> = {};
      data?.forEach((item) => {
        settings[item.setting_key] = item.setting_value;
      });
      
      return settings;
    },
  });

  // Load saved settings
  useEffect(() => {
    if (savedSettings) {
      if (savedSettings.company_info) {
        setCompanyInfo({ ...defaultCompanyInfo, ...savedSettings.company_info });
      }
      if (savedSettings.branding_settings) {
        setBranding({ ...defaultBrandingSettings, ...savedSettings.branding_settings });
      }
      if (savedSettings.localization_settings) {
        setLocalization({ ...defaultLocalization, ...savedSettings.localization_settings });
      }
      if (savedSettings.app_settings) {
        setAppSettings({ ...defaultAppSettings, ...savedSettings.app_settings });
      }
    }
  }, [savedSettings]);

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: async () => {
      const updates = [
        {
          setting_key: 'company_info',
          setting_value: JSON.parse(JSON.stringify(companyInfo)),
          description: 'Company information',
          updated_at: new Date().toISOString(),
        },
        {
          setting_key: 'branding_settings',
          setting_value: JSON.parse(JSON.stringify(branding)),
          description: 'Branding and theme settings',
          updated_at: new Date().toISOString(),
        },
        {
          setting_key: 'localization_settings',
          setting_value: JSON.parse(JSON.stringify(localization)),
          description: 'Localization and regional settings',
          updated_at: new Date().toISOString(),
        },
        {
          setting_key: 'app_settings',
          setting_value: JSON.parse(JSON.stringify(appSettings)),
          description: 'General app settings',
          updated_at: new Date().toISOString(),
        },
      ];

      for (const update of updates) {
        const { error } = await supabase
          .from('admin_settings')
          .upsert([update], { onConflict: 'setting_key' });
        
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['general-settings'] });
      setHasChanges(false);
      toast.success('Settings saved successfully');
    },
    onError: (error) => {
      toast.error('Failed to save settings: ' + (error as Error).message);
    },
  });

  const handleCompanyChange = (field: keyof CompanyInfo, value: string) => {
    setCompanyInfo(prev => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  const handleBrandingChange = (field: keyof BrandingSettings, value: string) => {
    setBranding(prev => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  const handleLocalizationChange = (field: keyof LocalizationSettings, value: any) => {
    setLocalization(prev => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  const handleAppSettingsChange = (field: keyof AppSettings, value: any) => {
    setAppSettings(prev => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  const toggleLanguage = (code: string) => {
    setLocalization(prev => {
      const languages = prev.supportedLanguages.includes(code)
        ? prev.supportedLanguages.filter(l => l !== code)
        : [...prev.supportedLanguages, code];
      return { ...prev, supportedLanguages: languages };
    });
    setHasChanges(true);
  };

  const handleReset = () => {
    setCompanyInfo(defaultCompanyInfo);
    setBranding(defaultBrandingSettings);
    setLocalization(defaultLocalization);
    setAppSettings(defaultAppSettings);
    setHasChanges(true);
    toast.info('Settings reset to defaults');
  };

  if (isLoading) {
    return (
      <AdminLayout title="General & Branding" description="Configure general settings and branding">
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout 
      title="General & Branding" 
      description="Configure company information, branding, and app settings"
    >
      <div className="space-y-6">
        {/* Action Bar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {hasChanges && (
              <Badge variant="outline" className="text-amber-600 border-amber-600">
                Unsaved Changes
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={handleReset}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Reset to Defaults
            </Button>
            <Button 
              onClick={() => saveMutation.mutate()}
              disabled={!hasChanges || saveMutation.isPending}
            >
              <Save className="h-4 w-4 mr-2" />
              {saveMutation.isPending ? 'Saving...' : 'Save All Changes'}
            </Button>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="company" className="flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              Company
            </TabsTrigger>
            <TabsTrigger value="branding" className="flex items-center gap-2">
              <Palette className="h-4 w-4" />
              Branding
            </TabsTrigger>
            <TabsTrigger value="localization" className="flex items-center gap-2">
              <Globe className="h-4 w-4" />
              Localization
            </TabsTrigger>
            <TabsTrigger value="app" className="flex items-center gap-2">
              <Monitor className="h-4 w-4" />
              App Settings
            </TabsTrigger>
          </TabsList>

          {/* Company Information Tab */}
          <TabsContent value="company" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Building2 className="h-5 w-5 text-primary" />
                  Company Information
                </CardTitle>
                <CardDescription>
                  Basic information about your company
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="companyName">Company Name</Label>
                    <Input
                      id="companyName"
                      value={companyInfo.name}
                      onChange={(e) => handleCompanyChange('name', e.target.value)}
                      placeholder="Enter company name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="legalName">Legal Name</Label>
                    <Input
                      id="legalName"
                      value={companyInfo.legalName}
                      onChange={(e) => handleCompanyChange('legalName', e.target.value)}
                      placeholder="Enter legal name"
                    />
                  </div>
                </div>

                <Separator />

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="email" className="flex items-center gap-2">
                      <Mail className="h-4 w-4" />
                      Email Address
                    </Label>
                    <Input
                      id="email"
                      type="email"
                      value={companyInfo.email}
                      onChange={(e) => handleCompanyChange('email', e.target.value)}
                      placeholder="contact@company.com"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="phone" className="flex items-center gap-2">
                      <Phone className="h-4 w-4" />
                      Phone Number
                    </Label>
                    <Input
                      id="phone"
                      value={companyInfo.phone}
                      onChange={(e) => handleCompanyChange('phone', e.target.value)}
                      placeholder="+1 (555) 123-4567"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="website" className="flex items-center gap-2">
                    <Globe className="h-4 w-4" />
                    Website
                  </Label>
                  <Input
                    id="website"
                    value={companyInfo.website}
                    onChange={(e) => handleCompanyChange('website', e.target.value)}
                    placeholder="https://www.company.com"
                  />
                </div>

                <Separator />

                <div className="space-y-2">
                  <Label htmlFor="address" className="flex items-center gap-2">
                    <MapPin className="h-4 w-4" />
                    Street Address
                  </Label>
                  <Input
                    id="address"
                    value={companyInfo.address}
                    onChange={(e) => handleCompanyChange('address', e.target.value)}
                    placeholder="123 Main Street"
                  />
                </div>

                <div className="grid gap-4 md:grid-cols-4">
                  <div className="space-y-2">
                    <Label htmlFor="city">City</Label>
                    <Input
                      id="city"
                      value={companyInfo.city}
                      onChange={(e) => handleCompanyChange('city', e.target.value)}
                      placeholder="City"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="state">State/Province</Label>
                    <Input
                      id="state"
                      value={companyInfo.state}
                      onChange={(e) => handleCompanyChange('state', e.target.value)}
                      placeholder="State"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="zipCode">ZIP/Postal Code</Label>
                    <Input
                      id="zipCode"
                      value={companyInfo.zipCode}
                      onChange={(e) => handleCompanyChange('zipCode', e.target.value)}
                      placeholder="12345"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="country">Country</Label>
                    <Input
                      id="country"
                      value={companyInfo.country}
                      onChange={(e) => handleCompanyChange('country', e.target.value)}
                      placeholder="Country"
                    />
                  </div>
                </div>

                <Separator />

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="taxId">Tax ID / EIN</Label>
                    <Input
                      id="taxId"
                      value={companyInfo.taxId}
                      onChange={(e) => handleCompanyChange('taxId', e.target.value)}
                      placeholder="XX-XXXXXXX"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="registrationNumber">Registration Number</Label>
                    <Input
                      id="registrationNumber"
                      value={companyInfo.registrationNumber}
                      onChange={(e) => handleCompanyChange('registrationNumber', e.target.value)}
                      placeholder="REG-123456"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Branding Tab */}
          <TabsContent value="branding" className="space-y-6">
            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Palette className="h-5 w-5 text-primary" />
                    Colors
                  </CardTitle>
                  <CardDescription>
                    Define your brand colors
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="primaryColor">Primary Color</Label>
                    <div className="flex items-center gap-3">
                      <input
                        type="color"
                        id="primaryColor"
                        value={branding.primaryColor}
                        onChange={(e) => handleBrandingChange('primaryColor', e.target.value)}
                        className="h-10 w-14 rounded-md border cursor-pointer"
                      />
                      <Input
                        value={branding.primaryColor}
                        onChange={(e) => handleBrandingChange('primaryColor', e.target.value)}
                        className="font-mono"
                        placeholder="#6366f1"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="secondaryColor">Secondary Color</Label>
                    <div className="flex items-center gap-3">
                      <input
                        type="color"
                        id="secondaryColor"
                        value={branding.secondaryColor}
                        onChange={(e) => handleBrandingChange('secondaryColor', e.target.value)}
                        className="h-10 w-14 rounded-md border cursor-pointer"
                      />
                      <Input
                        value={branding.secondaryColor}
                        onChange={(e) => handleBrandingChange('secondaryColor', e.target.value)}
                        className="font-mono"
                        placeholder="#8b5cf6"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="accentColor">Accent Color</Label>
                    <div className="flex items-center gap-3">
                      <input
                        type="color"
                        id="accentColor"
                        value={branding.accentColor}
                        onChange={(e) => handleBrandingChange('accentColor', e.target.value)}
                        className="h-10 w-14 rounded-md border cursor-pointer"
                      />
                      <Input
                        value={branding.accentColor}
                        onChange={(e) => handleBrandingChange('accentColor', e.target.value)}
                        className="font-mono"
                        placeholder="#f59e0b"
                      />
                    </div>
                  </div>

                  <Separator />

                  <div className="space-y-2">
                    <Label>Color Preview</Label>
                    <div className="flex items-center gap-2">
                      <div 
                        className="h-12 w-12 rounded-lg border-2 border-border"
                        style={{ backgroundColor: branding.primaryColor }}
                        title="Primary"
                      />
                      <div 
                        className="h-12 w-12 rounded-lg border-2 border-border"
                        style={{ backgroundColor: branding.secondaryColor }}
                        title="Secondary"
                      />
                      <div 
                        className="h-12 w-12 rounded-lg border-2 border-border"
                        style={{ backgroundColor: branding.accentColor }}
                        title="Accent"
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Type className="h-5 w-5 text-primary" />
                    Typography & Style
                  </CardTitle>
                  <CardDescription>
                    Fonts and design tokens
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="tagline">Tagline</Label>
                    <Input
                      id="tagline"
                      value={branding.tagline}
                      onChange={(e) => handleBrandingChange('tagline', e.target.value)}
                      placeholder="Your ride, your way"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="fontFamily">Font Family</Label>
                    <Select
                      value={branding.fontFamily}
                      onValueChange={(value) => handleBrandingChange('fontFamily', value)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select font" />
                      </SelectTrigger>
                      <SelectContent>
                        {fonts.map((font) => (
                          <SelectItem key={font} value={font} style={{ fontFamily: font }}>
                            {font}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="borderRadius">Border Radius</Label>
                    <Select
                      value={branding.borderRadius}
                      onValueChange={(value) => handleBrandingChange('borderRadius', value)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select radius" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None (0px)</SelectItem>
                        <SelectItem value="sm">Small (4px)</SelectItem>
                        <SelectItem value="md">Medium (8px)</SelectItem>
                        <SelectItem value="lg">Large (12px)</SelectItem>
                        <SelectItem value="xl">Extra Large (16px)</SelectItem>
                        <SelectItem value="full">Full (9999px)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <Separator />

                  <div className="space-y-2">
                    <Label>Preview</Label>
                    <div 
                      className="p-4 rounded-lg border-2"
                      style={{ 
                        fontFamily: branding.fontFamily,
                        borderColor: branding.primaryColor,
                        borderRadius: branding.borderRadius === 'none' ? '0' : 
                                     branding.borderRadius === 'sm' ? '4px' :
                                     branding.borderRadius === 'md' ? '8px' :
                                     branding.borderRadius === 'lg' ? '12px' :
                                     branding.borderRadius === 'xl' ? '16px' : '9999px'
                      }}
                    >
                      <p className="text-lg font-semibold" style={{ color: branding.primaryColor }}>
                        {companyInfo.name}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {branding.tagline}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Image className="h-5 w-5 text-primary" />
                  Brand Assets
                </CardTitle>
                <CardDescription>
                  Upload your logo, favicon, and app icons
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
                  {[
                    { key: 'logoUrl', label: 'Logo', hint: 'Recommended: 200x50px' },
                    { key: 'faviconUrl', label: 'Favicon', hint: 'Recommended: 32x32px' },
                    { key: 'appIconUrl', label: 'App Icon', hint: 'Recommended: 512x512px' },
                    { key: 'splashScreenUrl', label: 'Splash Screen', hint: 'Recommended: 1080x1920px' },
                  ].map((asset) => (
                    <div key={asset.key} className="space-y-2">
                      <Label>{asset.label}</Label>
                      <div className="border-2 border-dashed rounded-lg p-4 text-center hover:border-primary transition-colors">
                        {branding[asset.key as keyof BrandingSettings] ? (
                          <div className="space-y-2">
                            <img 
                              src={branding[asset.key as keyof BrandingSettings] as string} 
                              alt={asset.label}
                              className="max-h-20 mx-auto object-contain"
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleBrandingChange(asset.key as keyof BrandingSettings, '')}
                            >
                              <Trash2 className="h-4 w-4 mr-1" />
                              Remove
                            </Button>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <Upload className="h-8 w-8 mx-auto text-muted-foreground" />
                            <p className="text-xs text-muted-foreground">{asset.hint}</p>
                            <Input
                              type="url"
                              placeholder="Enter URL"
                              className="text-xs"
                              onChange={(e) => handleBrandingChange(asset.key as keyof BrandingSettings, e.target.value)}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Localization Tab */}
          <TabsContent value="localization" className="space-y-6">
            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Languages className="h-5 w-5 text-primary" />
                    Languages
                  </CardTitle>
                  <CardDescription>
                    Configure supported languages
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="defaultLanguage">Default Language</Label>
                    <Select
                      value={localization.defaultLanguage}
                      onValueChange={(value) => handleLocalizationChange('defaultLanguage', value)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select language" />
                      </SelectTrigger>
                      <SelectContent>
                        {languages.map((lang) => (
                          <SelectItem key={lang.code} value={lang.code}>
                            {lang.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <Separator />

                  <div className="space-y-2">
                    <Label>Supported Languages</Label>
                    <div className="flex flex-wrap gap-2">
                      {languages.map((lang) => (
                        <Badge
                          key={lang.code}
                          variant={localization.supportedLanguages.includes(lang.code) ? 'default' : 'outline'}
                          className="cursor-pointer"
                          onClick={() => toggleLanguage(lang.code)}
                        >
                          {localization.supportedLanguages.includes(lang.code) ? (
                            <Check className="h-3 w-3 mr-1" />
                          ) : (
                            <X className="h-3 w-3 mr-1" />
                          )}
                          {lang.name}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Clock className="h-5 w-5 text-primary" />
                    Date & Time
                  </CardTitle>
                  <CardDescription>
                    Configure date and time formats
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="timezone">Default Timezone</Label>
                    <Select
                      value={localization.defaultTimezone}
                      onValueChange={(value) => handleLocalizationChange('defaultTimezone', value)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select timezone" />
                      </SelectTrigger>
                      <SelectContent>
                        {timezones.map((tz) => (
                          <SelectItem key={tz} value={tz}>
                            {tz}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="dateFormat">Date Format</Label>
                    <Select
                      value={localization.dateFormat}
                      onValueChange={(value) => handleLocalizationChange('dateFormat', value)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select format" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="MM/DD/YYYY">MM/DD/YYYY</SelectItem>
                        <SelectItem value="DD/MM/YYYY">DD/MM/YYYY</SelectItem>
                        <SelectItem value="YYYY-MM-DD">YYYY-MM-DD</SelectItem>
                        <SelectItem value="DD.MM.YYYY">DD.MM.YYYY</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="timeFormat">Time Format</Label>
                    <Select
                      value={localization.timeFormat}
                      onValueChange={(value) => handleLocalizationChange('timeFormat', value)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select format" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="12h">12-hour (AM/PM)</SelectItem>
                        <SelectItem value="24h">24-hour</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-amber-200 bg-amber-50/50 dark:bg-amber-950/20 dark:border-amber-800">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <DollarSign className="h-5 w-5 text-amber-600" />
                    Currency & Units
                  </CardTitle>
                  <CardDescription>
                    Currency and distance units are configured per <strong>Region</strong> — the single source of truth.
                    Go to <strong>Regions</strong> to manage these settings.
                  </CardDescription>
                </CardHeader>
              </Card>
            </div>
          </TabsContent>

          {/* App Settings Tab */}
          <TabsContent value="app" className="space-y-6">
            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Monitor className="h-5 w-5 text-primary" />
                    Application
                  </CardTitle>
                  <CardDescription>
                    General application settings
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="appName">App Name</Label>
                      <Input
                        id="appName"
                        value={appSettings.appName}
                        onChange={(e) => handleAppSettingsChange('appName', e.target.value)}
                        placeholder="App Name"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="appVersion">Version</Label>
                      <Input
                        id="appVersion"
                        value={appSettings.appVersion}
                        onChange={(e) => handleAppSettingsChange('appVersion', e.target.value)}
                        placeholder="1.0.0"
                      />
                    </div>
                  </div>

                  <Separator />

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>Maintenance Mode</Label>
                      <p className="text-sm text-muted-foreground">
                        Disable the app for all users
                      </p>
                    </div>
                    <Switch
                      checked={appSettings.maintenanceMode}
                      onCheckedChange={(checked) => handleAppSettingsChange('maintenanceMode', checked)}
                    />
                  </div>

                  {appSettings.maintenanceMode && (
                    <div className="space-y-2">
                      <Label htmlFor="maintenanceMessage">Maintenance Message</Label>
                      <Textarea
                        id="maintenanceMessage"
                        value={appSettings.maintenanceMessage}
                        onChange={(e) => handleAppSettingsChange('maintenanceMessage', e.target.value)}
                        placeholder="We are currently performing scheduled maintenance..."
                        rows={3}
                      />
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Shield className="h-5 w-5 text-primary" />
                    Registration & Verification
                  </CardTitle>
                  <CardDescription>
                    User registration settings
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>Allow Registration</Label>
                      <p className="text-sm text-muted-foreground">
                        Allow new users to sign up
                      </p>
                    </div>
                    <Switch
                      checked={appSettings.allowRegistration}
                      onCheckedChange={(checked) => handleAppSettingsChange('allowRegistration', checked)}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>Require Email Verification</Label>
                      <p className="text-sm text-muted-foreground">
                        Users must verify their email
                      </p>
                    </div>
                    <Switch
                      checked={appSettings.requireEmailVerification}
                      onCheckedChange={(checked) => handleAppSettingsChange('requireEmailVerification', checked)}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>Require Phone Verification</Label>
                      <p className="text-sm text-muted-foreground">
                        Users must verify their phone number
                      </p>
                    </div>
                    <Switch
                      checked={appSettings.requirePhoneVerification}
                      onCheckedChange={(checked) => handleAppSettingsChange('requirePhoneVerification', checked)}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Mail className="h-5 w-5 text-primary" />
                    Support & Legal
                  </CardTitle>
                  <CardDescription>
                    Support contact and legal pages
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="supportEmail">Support Email</Label>
                      <Input
                        id="supportEmail"
                        type="email"
                        value={appSettings.supportEmail}
                        onChange={(e) => handleAppSettingsChange('supportEmail', e.target.value)}
                        placeholder="support@company.com"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="supportPhone">Support Phone</Label>
                      <Input
                        id="supportPhone"
                        value={appSettings.supportPhone}
                        onChange={(e) => handleAppSettingsChange('supportPhone', e.target.value)}
                        placeholder="+1 (555) 987-6543"
                      />
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="termsUrl">Terms of Service URL</Label>
                      <Input
                        id="termsUrl"
                        value={appSettings.termsUrl}
                        onChange={(e) => handleAppSettingsChange('termsUrl', e.target.value)}
                        placeholder="/terms"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="privacyUrl">Privacy Policy URL</Label>
                      <Input
                        id="privacyUrl"
                        value={appSettings.privacyUrl}
                        onChange={(e) => handleAppSettingsChange('privacyUrl', e.target.value)}
                        placeholder="/privacy"
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Globe className="h-5 w-5 text-primary" />
                    Social Links
                  </CardTitle>
                  <CardDescription>
                    Social media profiles
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="facebook">Facebook</Label>
                    <Input
                      id="facebook"
                      value={appSettings.socialLinks.facebook}
                      onChange={(e) => handleAppSettingsChange('socialLinks', { ...appSettings.socialLinks, facebook: e.target.value })}
                      placeholder="https://facebook.com/yourpage"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="twitter">Twitter / X</Label>
                    <Input
                      id="twitter"
                      value={appSettings.socialLinks.twitter}
                      onChange={(e) => handleAppSettingsChange('socialLinks', { ...appSettings.socialLinks, twitter: e.target.value })}
                      placeholder="https://twitter.com/yourhandle"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="instagram">Instagram</Label>
                    <Input
                      id="instagram"
                      value={appSettings.socialLinks.instagram}
                      onChange={(e) => handleAppSettingsChange('socialLinks', { ...appSettings.socialLinks, instagram: e.target.value })}
                      placeholder="https://instagram.com/yourprofile"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="linkedin">LinkedIn</Label>
                    <Input
                      id="linkedin"
                      value={appSettings.socialLinks.linkedin}
                      onChange={(e) => handleAppSettingsChange('socialLinks', { ...appSettings.socialLinks, linkedin: e.target.value })}
                      placeholder="https://linkedin.com/company/yourcompany"
                    />
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </AdminLayout>
  );
}
