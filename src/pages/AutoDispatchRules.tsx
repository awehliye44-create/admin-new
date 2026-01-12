import { useState, useEffect } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { 
  RotateCcw, 
  Save, 
  Globe, 
  Layers, 
  Clock, 
  Info,
  Percent,
  Timer
} from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

interface DispatchSettings {
  // Core Dispatch Settings
  maxOffersPerRequest: number;
  searchRadiusMeters: number;
  offerExpirySeconds: number;
  batchMode: 'parallel' | 'cascade';

  // Driver Filtering
  minimumRating: number;
  maxCancelRate: number;

  // Anti-Spam & Cooldown
  cooldownAfterRejectSeconds: number;
  maxConcurrentOffersPerDriver: number;

  // Cascade Settings
  cascadeBatchSize: number;
  cascadeStepDelaySeconds: number;

  // Driver Priority & Sorting
  priorityOrder: 'nearest' | 'rating' | 'acceptance' | 'waiting';
  suppressRecentOffersSeconds: number;

  // Stacked Rides
  stackedRidesEnabled: boolean;
  maxStackedRides: number;
  stackedSearchRadiusMeters: number;
  stackedMinTripDistanceKm: number;
  stackedMaxDetourMinutes: number;
  stackedOfferWindowMinutes: number;
  stackedPriorityMode: 'same_direction' | 'nearest' | 'highest_fare';
  stackedDriverIncentive: number;
  stackedRiderDiscount: number;
  stackedShowEtaToDriver: boolean;
  stackedAllowRiderOptOut: boolean;

  // Scheduled Rides
  scheduledRidesEnabled: boolean;
  minAdvanceTimeMinutes: number;
  maxAdvanceDays: number;
  waitingTimeGracePeriodMinutes: number;
  scheduledRideIncentivesEnabled: boolean;

  // Retry & Timeout
  acceptTimeoutSeconds: number;
  globalTimeoutMinutes: number;
  maxOfferHops: number;
  autoRetryAttempts: number;
  autoReassignEnabled: boolean;
  instantRetryEnabled: boolean;

  // System Settings
  enableLogging: boolean;
  simulateMode: boolean;
  blockMultipleActiveRides: boolean;
  cancelProtection: boolean;

  // Driver Fare Visibility
  driverFareDisplay: 'net_earnings' | 'full_breakdown';
}

const defaultSettings: DispatchSettings = {
  maxOffersPerRequest: 5,
  searchRadiusMeters: 3000,
  offerExpirySeconds: 20,
  batchMode: 'parallel',
  minimumRating: 0,
  maxCancelRate: 0,
  cooldownAfterRejectSeconds: 180,
  maxConcurrentOffersPerDriver: 1,
  cascadeBatchSize: 3,
  cascadeStepDelaySeconds: 8,
  priorityOrder: 'nearest',
  suppressRecentOffersSeconds: 60,
  // Stacked Rides
  stackedRidesEnabled: false,
  maxStackedRides: 1,
  stackedSearchRadiusMeters: 2000,
  stackedMinTripDistanceKm: 3,
  stackedMaxDetourMinutes: 10,
  stackedOfferWindowMinutes: 5,
  stackedPriorityMode: 'same_direction',
  stackedDriverIncentive: 5,
  stackedRiderDiscount: 10,
  stackedShowEtaToDriver: true,
  stackedAllowRiderOptOut: true,
  // Scheduled Rides
  scheduledRidesEnabled: true,
  minAdvanceTimeMinutes: 15,
  maxAdvanceDays: 30,
  waitingTimeGracePeriodMinutes: 5,
  scheduledRideIncentivesEnabled: false,
  // Retry & Timeout
  acceptTimeoutSeconds: 12,
  globalTimeoutMinutes: 15,
  maxOfferHops: 10,
  autoRetryAttempts: 3,
  autoReassignEnabled: false,
  instantRetryEnabled: false,
  // System
  enableLogging: false,
  simulateMode: false,
  blockMultipleActiveRides: false,
  cancelProtection: false,
  driverFareDisplay: 'net_earnings',
};

export default function AutoDispatchRules() {
  const [settings, setSettings] = useState<DispatchSettings>(defaultSettings);
  const [serviceArea, setServiceArea] = useState('all');
  const [scheduledTab, setScheduledTab] = useState('booking');
  const [stackedTab, setStackedTab] = useState('general');
  const [isSaving, setIsSaving] = useState(false);
  const [maxDriverFindTime, setMaxDriverFindTime] = useState(3);
  const [isLoadingSettings, setIsLoadingSettings] = useState(true);

  // Load dispatch settings from database
  useEffect(() => {
    const loadDispatchSettings = async () => {
      try {
        const { data, error } = await supabase
          .from('dispatch_settings')
          .select('*')
          .is('service_area_id', null)
          .single();

        if (data && !error) {
          setMaxDriverFindTime(data.max_driver_find_time_minutes);
        }
      } catch (err) {
        console.error('Error loading dispatch settings:', err);
      } finally {
        setIsLoadingSettings(false);
      }
    };

    loadDispatchSettings();
  }, []);

  const updateSetting = <K extends keyof DispatchSettings>(
    key: K,
    value: DispatchSettings[K]
  ) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const handleReset = () => {
    setSettings(defaultSettings);
    setMaxDriverFindTime(3);
    toast.info('Settings reset to defaults');
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Save max driver find time to database
      const { error } = await supabase
        .from('dispatch_settings')
        .upsert({
          service_area_id: null,
          max_driver_find_time_minutes: maxDriverFindTime
        }, {
          onConflict: 'service_area_id'
        });

      if (error) throw error;

      toast.success('Auto-dispatch settings saved successfully');
    } catch (err) {
      console.error('Error saving settings:', err);
      toast.error('Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <AdminLayout 
      title="Auto-Dispatch Rules" 
      description="Configure automatic dispatch settings"
    >
      {/* Header with Service Area selector and action buttons */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <Label className="text-sm text-muted-foreground">Service Area:</Label>
          <Select value={serviceArea} onValueChange={setServiceArea}>
            <SelectTrigger className="w-[200px]">
              <Globe className="h-4 w-4 mr-2" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Service Areas</SelectItem>
              <SelectItem value="london">London</SelectItem>
              <SelectItem value="bedford">Bedford</SelectItem>
              <SelectItem value="milton-keynes">Milton Keynes</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleReset}>
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            <Save className="mr-2 h-4 w-4" />
            {isSaving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </div>

      <div className="space-y-6">
        {/* Driver Finding Time - Priority Setting */}
        <Card className="border-primary/50">
          <CardHeader>
            <div className="flex items-center gap-3">
              <Timer className="h-5 w-5 text-primary" />
              <div>
                <CardTitle>Maximum Time to Find Driver</CardTitle>
                <CardDescription>
                  Set how long the system searches for a driver before timing out
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label>Maximum Search Time (minutes)</Label>
                <Input
                  type="number"
                  min="1"
                  max="15"
                  value={maxDriverFindTime}
                  onChange={(e) => setMaxDriverFindTime(Math.max(1, Math.min(15, parseInt(e.target.value) || 3)))}
                  disabled={isLoadingSettings}
                />
                <p className="text-xs text-muted-foreground">
                  Default: 3 minutes. Range: 1-15 minutes.
                </p>
              </div>
              <div className="flex items-center">
                <div className="p-4 bg-muted/50 rounded-lg w-full">
                  <p className="text-sm font-medium">Current Setting</p>
                  <p className="text-2xl font-bold text-primary">{maxDriverFindTime} min</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Trips will expire if no driver accepts within this time
                  </p>
                </div>
              </div>
            </div>

            {/* Info box */}
            <div className="flex items-start gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
              <Info className="h-4 w-4 text-blue-600 mt-0.5" />
              <div className="text-sm text-blue-700 dark:text-blue-400">
                <p className="font-medium">How it works:</p>
                <ul className="list-disc list-inside mt-1 space-y-1">
                  <li>Customer sees a countdown timer while searching</li>
                  <li>If no driver accepts, trip is marked as "No Driver Found"</li>
                  <li>Customer receives: "No drivers available right now. Please try again."</li>
                  <li>Late acceptances are blocked after timeout</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Core Dispatch Settings */}
        <Card>
          <CardHeader>
            <CardTitle>Core Dispatch Settings</CardTitle>
            <CardDescription>Configure how rides are dispatched to drivers</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label>Max Offers Per Request</Label>
                <Input
                  type="number"
                  value={settings.maxOffersPerRequest}
                  onChange={(e) => updateSetting('maxOffersPerRequest', parseInt(e.target.value) || 0)}
                />
              </div>
              <div className="space-y-2">
                <Label>Search Radius (meters)</Label>
                <Input
                  type="number"
                  value={settings.searchRadiusMeters}
                  onChange={(e) => updateSetting('searchRadiusMeters', parseInt(e.target.value) || 0)}
                />
              </div>
              <div className="space-y-2">
                <Label>Offer Expiry (seconds)</Label>
                <Input
                  type="number"
                  value={settings.offerExpirySeconds}
                  onChange={(e) => updateSetting('offerExpirySeconds', parseInt(e.target.value) || 0)}
                />
              </div>
              <div className="space-y-2">
                <Label>Batch Mode</Label>
                <Select 
                  value={settings.batchMode} 
                  onValueChange={(value: 'parallel' | 'cascade') => updateSetting('batchMode', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="parallel">Parallel</SelectItem>
                    <SelectItem value="cascade">Cascade</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Driver Filtering */}
        <Card>
          <CardHeader>
            <CardTitle>Driver Filtering</CardTitle>
            <CardDescription>Set minimum requirements for drivers</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label>Minimum Rating</Label>
                <Input
                  type="number"
                  step="0.1"
                  min="0"
                  max="5"
                  value={settings.minimumRating}
                  onChange={(e) => updateSetting('minimumRating', parseFloat(e.target.value) || 0)}
                />
              </div>
              <div className="space-y-2">
                <Label>Max Cancel Rate (%)</Label>
                <Input
                  type="number"
                  min="0"
                  max="100"
                  value={settings.maxCancelRate}
                  onChange={(e) => updateSetting('maxCancelRate', parseInt(e.target.value) || 0)}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Anti-Spam & Cooldown */}
        <Card>
          <CardHeader>
            <CardTitle>Anti-Spam & Cooldown</CardTitle>
            <CardDescription>Prevent driver spam and manage cooldowns</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label>Cooldown After Reject (seconds)</Label>
                <Input
                  type="number"
                  value={settings.cooldownAfterRejectSeconds}
                  onChange={(e) => updateSetting('cooldownAfterRejectSeconds', parseInt(e.target.value) || 0)}
                />
              </div>
              <div className="space-y-2">
                <Label>Max Concurrent Offers Per Driver</Label>
                <Input
                  type="number"
                  value={settings.maxConcurrentOffersPerDriver}
                  onChange={(e) => updateSetting('maxConcurrentOffersPerDriver', parseInt(e.target.value) || 0)}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Cascade Settings */}
        <Card>
          <CardHeader>
            <CardTitle>Cascade Settings</CardTitle>
            <CardDescription>Configure cascade batch dispatch behavior</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label>Cascade Batch Size</Label>
                <Input
                  type="number"
                  value={settings.cascadeBatchSize}
                  onChange={(e) => updateSetting('cascadeBatchSize', parseInt(e.target.value) || 0)}
                />
              </div>
              <div className="space-y-2">
                <Label>Cascade Step Delay (seconds)</Label>
                <Input
                  type="number"
                  value={settings.cascadeStepDelaySeconds}
                  onChange={(e) => updateSetting('cascadeStepDelaySeconds', parseInt(e.target.value) || 0)}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Driver Priority & Sorting */}
        <Card>
          <CardHeader>
            <CardTitle>Driver Priority & Sorting</CardTitle>
            <CardDescription>Configure how drivers are prioritized for ride offers</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label>Priority Order</Label>
                <Select 
                  value={settings.priorityOrder} 
                  onValueChange={(value: 'nearest' | 'rating' | 'acceptance' | 'waiting') => updateSetting('priorityOrder', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="nearest">Nearest First</SelectItem>
                    <SelectItem value="rating">Highest Rating First</SelectItem>
                    <SelectItem value="acceptance">Best Acceptance Rate</SelectItem>
                    <SelectItem value="waiting">Longest Waiting First</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Suppress Recent Offers Within (seconds)</Label>
                <Input
                  type="number"
                  value={settings.suppressRecentOffersSeconds}
                  onChange={(e) => updateSetting('suppressRecentOffersSeconds', parseInt(e.target.value) || 0)}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Stacked Rides Configuration */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Layers className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle>Stacked Rides Configuration</CardTitle>
                <CardDescription>Configure chained/stacked ride offers to drivers</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Stacked Rides Toggle */}
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-medium">Stacked Rides</p>
                <p className="text-sm text-muted-foreground">Enable or disable stacked ride offers system-wide</p>
              </div>
              <Switch
                checked={settings.stackedRidesEnabled}
                onCheckedChange={(checked) => updateSetting('stackedRidesEnabled', checked)}
              />
            </div>

            {/* Tabs for Stacked Rides */}
            <Tabs value={stackedTab} onValueChange={setStackedTab}>
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="general">General</TabsTrigger>
                <TabsTrigger value="matching">Matching Rules</TabsTrigger>
                <TabsTrigger value="incentives">Incentives</TabsTrigger>
                <TabsTrigger value="display">Display Options</TabsTrigger>
              </TabsList>

              <TabsContent value="general" className="space-y-6 pt-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label>Max Stacked Rides</Label>
                    <Input
                      type="number"
                      min="1"
                      max="3"
                      value={settings.maxStackedRides}
                      onChange={(e) => updateSetting('maxStackedRides', parseInt(e.target.value) || 1)}
                    />
                    <p className="text-xs text-muted-foreground">Maximum queued rides per driver (1-3)</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Stacked Search Radius (meters)</Label>
                    <Input
                      type="number"
                      value={settings.stackedSearchRadiusMeters}
                      onChange={(e) => updateSetting('stackedSearchRadiusMeters', parseInt(e.target.value) || 0)}
                    />
                    <p className="text-xs text-muted-foreground">Search radius for finding stackable rides</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Offer Window (minutes)</Label>
                    <Input
                      type="number"
                      value={settings.stackedOfferWindowMinutes}
                      onChange={(e) => updateSetting('stackedOfferWindowMinutes', parseInt(e.target.value) || 0)}
                    />
                    <p className="text-xs text-muted-foreground">Time before current trip ends to offer stacked ride</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Priority Mode</Label>
                    <Select 
                      value={settings.stackedPriorityMode} 
                      onValueChange={(value: 'same_direction' | 'nearest' | 'highest_fare') => updateSetting('stackedPriorityMode', value)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="same_direction">Same Direction First</SelectItem>
                        <SelectItem value="nearest">Nearest Pickup First</SelectItem>
                        <SelectItem value="highest_fare">Highest Fare First</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">How to prioritize stacked ride offers</p>
                  </div>
                </div>

                {/* Info box */}
                <div className="flex items-start gap-2 p-3 bg-muted/50 rounded-lg">
                  <Info className="h-4 w-4 text-muted-foreground mt-0.5" />
                  <p className="text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">OFF:</span> Single-ride mode only.{' '}
                    <span className="font-medium text-foreground">ON:</span> Drivers may receive queued rides while on an active trip.
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="matching" className="space-y-6 pt-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label>Minimum Trip Distance (km)</Label>
                    <Input
                      type="number"
                      step="0.5"
                      value={settings.stackedMinTripDistanceKm}
                      onChange={(e) => updateSetting('stackedMinTripDistanceKm', parseFloat(e.target.value) || 0)}
                    />
                    <p className="text-xs text-muted-foreground">Minimum trip distance to qualify for stacking</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Max Detour Time (minutes)</Label>
                    <Input
                      type="number"
                      value={settings.stackedMaxDetourMinutes}
                      onChange={(e) => updateSetting('stackedMaxDetourMinutes', parseInt(e.target.value) || 0)}
                    />
                    <p className="text-xs text-muted-foreground">Maximum detour allowed for stacked pickup</p>
                  </div>
                </div>

                {/* Matching info */}
                <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                  <Info className="h-4 w-4 text-amber-600 mt-0.5" />
                  <p className="text-sm text-amber-700 dark:text-amber-400">
                    Rides are matched based on proximity to current drop-off, travel direction, and ETA compatibility.
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="incentives" className="space-y-6 pt-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label>Driver Incentive (%)</Label>
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      value={settings.stackedDriverIncentive}
                      onChange={(e) => updateSetting('stackedDriverIncentive', parseInt(e.target.value) || 0)}
                    />
                    <p className="text-xs text-muted-foreground">Bonus percentage for accepting stacked rides</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Rider Discount (%)</Label>
                    <Input
                      type="number"
                      min="0"
                      max="50"
                      value={settings.stackedRiderDiscount}
                      onChange={(e) => updateSetting('stackedRiderDiscount', parseInt(e.target.value) || 0)}
                    />
                    <p className="text-xs text-muted-foreground">Discount for riders who opt into stacked rides</p>
                  </div>
                </div>

                {/* Incentive info */}
                <div className="flex items-start gap-2 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
                  <Percent className="h-4 w-4 text-green-600 mt-0.5" />
                  <p className="text-sm text-green-700 dark:text-green-400">
                    Incentives help increase stacked ride acceptance rates and rider participation.
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="display" className="space-y-4 pt-4">
                <div className="flex items-center justify-between p-4 border rounded-lg">
                  <div>
                    <p className="font-medium">Show ETA to Driver</p>
                    <p className="text-sm text-muted-foreground">Display estimated pickup time for stacked ride</p>
                  </div>
                  <Switch
                    checked={settings.stackedShowEtaToDriver}
                    onCheckedChange={(checked) => updateSetting('stackedShowEtaToDriver', checked)}
                  />
                </div>
                <div className="flex items-center justify-between p-4 border rounded-lg">
                  <div>
                    <p className="font-medium">Allow Rider Opt-Out</p>
                    <p className="text-sm text-muted-foreground">Let riders choose to not be part of stacked rides</p>
                  </div>
                  <Switch
                    checked={settings.stackedAllowRiderOptOut}
                    onCheckedChange={(checked) => updateSetting('stackedAllowRiderOptOut', checked)}
                  />
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        {/* Scheduled Rides Configuration */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Clock className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle>Scheduled Rides Configuration</CardTitle>
                <CardDescription>Complete settings for advance scheduled rides dispatch</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Scheduled Rides Toggle */}
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-medium">Scheduled Rides</p>
                <p className="text-sm text-muted-foreground">Enable or disable scheduled ride bookings system-wide</p>
              </div>
              <Switch
                checked={settings.scheduledRidesEnabled}
                onCheckedChange={(checked) => updateSetting('scheduledRidesEnabled', checked)}
              />
            </div>

            {/* Tabs for Scheduled Rides */}
            <Tabs value={scheduledTab} onValueChange={setScheduledTab}>
              <TabsList className="grid w-full grid-cols-5">
                <TabsTrigger value="booking">Booking Window</TabsTrigger>
                <TabsTrigger value="dispatch">Dispatch</TabsTrigger>
                <TabsTrigger value="search">Search & Radius</TabsTrigger>
                <TabsTrigger value="reminders">Reminders</TabsTrigger>
                <TabsTrigger value="timeout">Timeout & Retry</TabsTrigger>
              </TabsList>
              
              <TabsContent value="booking" className="space-y-6 pt-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label>Minimum Advance Time (minutes)</Label>
                    <Input
                      type="number"
                      value={settings.minAdvanceTimeMinutes}
                      onChange={(e) => updateSetting('minAdvanceTimeMinutes', parseInt(e.target.value) || 0)}
                    />
                    <p className="text-xs text-muted-foreground">Minimum time before a ride can be scheduled</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Maximum Advance Days</Label>
                    <Input
                      type="number"
                      value={settings.maxAdvanceDays}
                      onChange={(e) => updateSetting('maxAdvanceDays', parseInt(e.target.value) || 0)}
                    />
                    <p className="text-xs text-muted-foreground">How far in advance rides can be booked</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Waiting Time Grace Period (minutes)</Label>
                    <Input
                      type="number"
                      value={settings.waitingTimeGracePeriodMinutes}
                      onChange={(e) => updateSetting('waitingTimeGracePeriodMinutes', parseInt(e.target.value) || 0)}
                    />
                    <p className="text-xs text-muted-foreground">Free waiting time before charges apply</p>
                  </div>
                </div>

                {/* Scheduled Ride Incentives */}
                <div className="flex items-center justify-between p-4 border rounded-lg">
                  <div>
                    <p className="font-medium">Scheduled Ride Incentives</p>
                    <p className="text-sm text-muted-foreground">Offer bonus for early acceptance</p>
                  </div>
                  <Switch
                    checked={settings.scheduledRideIncentivesEnabled}
                    onCheckedChange={(checked) => updateSetting('scheduledRideIncentivesEnabled', checked)}
                  />
                </div>
              </TabsContent>

              <TabsContent value="dispatch" className="pt-4">
                <p className="text-muted-foreground">Dispatch settings for scheduled rides will appear here.</p>
              </TabsContent>

              <TabsContent value="search" className="pt-4">
                <p className="text-muted-foreground">Search radius settings for scheduled rides will appear here.</p>
              </TabsContent>

              <TabsContent value="reminders" className="pt-4">
                <p className="text-muted-foreground">Reminder settings for scheduled rides will appear here.</p>
              </TabsContent>

              <TabsContent value="timeout" className="pt-4">
                <p className="text-muted-foreground">Timeout settings for scheduled rides will appear here.</p>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        {/* Retry & Timeout Configuration */}
        <Card>
          <CardHeader>
            <CardTitle>Retry & Timeout Configuration</CardTitle>
            <CardDescription>Configure retry logic and timeout behaviors</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label>Accept Timeout (seconds)</Label>
                <Input
                  type="number"
                  value={settings.acceptTimeoutSeconds}
                  onChange={(e) => updateSetting('acceptTimeoutSeconds', parseInt(e.target.value) || 0)}
                />
              </div>
              <div className="space-y-2">
                <Label>Global Timeout (minutes)</Label>
                <Input
                  type="number"
                  value={settings.globalTimeoutMinutes}
                  onChange={(e) => updateSetting('globalTimeoutMinutes', parseInt(e.target.value) || 0)}
                />
              </div>
              <div className="space-y-2">
                <Label>Max Offer Hops</Label>
                <Input
                  type="number"
                  value={settings.maxOfferHops}
                  onChange={(e) => updateSetting('maxOfferHops', parseInt(e.target.value) || 0)}
                />
              </div>
              <div className="space-y-2">
                <Label>Auto Retry Attempts</Label>
                <Input
                  type="number"
                  value={settings.autoRetryAttempts}
                  onChange={(e) => updateSetting('autoRetryAttempts', parseInt(e.target.value) || 0)}
                />
              </div>
            </div>

            {/* Toggle options */}
            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 border rounded-lg">
                <div>
                  <p className="font-medium">Auto Reassign Enabled</p>
                  <p className="text-sm text-muted-foreground">Automatically reassign rejected rides</p>
                </div>
                <Switch
                  checked={settings.autoReassignEnabled}
                  onCheckedChange={(checked) => updateSetting('autoReassignEnabled', checked)}
                />
              </div>
              <div className="flex items-center justify-between p-4 border rounded-lg">
                <div>
                  <p className="font-medium">Instant Retry Enabled</p>
                  <p className="text-sm text-muted-foreground">Retry immediately on rejection</p>
                </div>
                <Switch
                  checked={settings.instantRetryEnabled}
                  onCheckedChange={(checked) => updateSetting('instantRetryEnabled', checked)}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* System Settings */}
        <Card>
          <CardHeader>
            <CardTitle>System Settings</CardTitle>
            <CardDescription>Advanced dispatch system configuration</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-medium">Enable Logging</p>
                <p className="text-sm text-muted-foreground">Log all dispatch events</p>
              </div>
              <Switch
                checked={settings.enableLogging}
                onCheckedChange={(checked) => updateSetting('enableLogging', checked)}
              />
            </div>
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-medium">Simulate Mode</p>
                <p className="text-sm text-muted-foreground">Test dispatch without actual assignments</p>
              </div>
              <Switch
                checked={settings.simulateMode}
                onCheckedChange={(checked) => updateSetting('simulateMode', checked)}
              />
            </div>
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-medium">Block Multiple Active Rides</p>
                <p className="text-sm text-muted-foreground">Prevent drivers from having multiple active rides</p>
              </div>
              <Switch
                checked={settings.blockMultipleActiveRides}
                onCheckedChange={(checked) => updateSetting('blockMultipleActiveRides', checked)}
              />
            </div>
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-medium">Cancel Protection</p>
                <p className="text-sm text-muted-foreground">Protect drivers from cancellation penalties</p>
              </div>
              <Switch
                checked={settings.cancelProtection}
                onCheckedChange={(checked) => updateSetting('cancelProtection', checked)}
              />
            </div>
          </CardContent>
        </Card>

        {/* Driver Fare Visibility */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Percent className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle>Driver Fare Visibility</CardTitle>
                <CardDescription>Control how drivers see fare information in their app</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label>Driver Fare Display</Label>
              <Select 
                value={settings.driverFareDisplay} 
                onValueChange={(value: 'net_earnings' | 'full_breakdown') => updateSetting('driverFareDisplay', value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="net_earnings">Net Earnings Only (Recommended)</SelectItem>
                  <SelectItem value="full_breakdown">Full Breakdown</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Visual Examples */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className={`p-4 border-2 rounded-lg ${settings.driverFareDisplay === 'net_earnings' ? 'border-green-500 bg-green-500/5' : 'border-border'}`}>
                <p className="font-medium text-green-600 mb-3">£ Net Earnings Only</p>
                <div className="p-3 bg-background border rounded-lg">
                  <p className="text-green-600">£ Your Earnings: £21.05</p>
                </div>
                <p className="text-sm text-green-600 mt-3">Simple, clean display focusing on driver earnings</p>
              </div>
              <div className={`p-4 border-2 rounded-lg ${settings.driverFareDisplay === 'full_breakdown' ? 'border-green-500 bg-green-500/5' : 'border-border'}`}>
                <p className="font-medium text-green-600 mb-3">Full Breakdown</p>
                <div className="p-3 bg-background border rounded-lg space-y-1">
                  <p className="text-green-600">£ Rider Fare: £25.00</p>
                  <p className="text-red-500">Commission: -£3.75</p>
                  <p className="text-green-600">£ Your Earnings: £21.05</p>
                </div>
                <p className="text-sm text-green-600 mt-3">Transparent view of all fare components</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
