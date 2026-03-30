import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/hooks/use-toast';
import { QRCodeSVG } from 'qrcode.react';
import { Save, Download, Copy, Check, QrCode, MapPin, Shield, History } from 'lucide-react';
import { format } from 'date-fns';

const QR_URL = 'https://guest.onecab.net?source=qr';

interface QrConfig {
  id: string;
  pickup_name: string;
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  status: string;
  qr_url: string;
  updated_at: string;
  allow_cash: boolean;
  allow_card: boolean;
  allow_apple_pay: boolean;
  allow_google_pay: boolean;
}

interface AuditEntry {
  id: string;
  changed_by_email: string | null;
  old_values: Record<string, unknown>;
  new_values: Record<string, unknown>;
  created_at: string;
}

export default function QrBookingControl() {
  const { user } = useAuth();
  const [config, setConfig] = useState<QrConfig | null>(null);
  const [form, setForm] = useState({ pickup_name: '', pickup_address: '', pickup_lat: '', pickup_lng: '', status: 'disabled', allow_cash: true, allow_card: true, allow_apple_pay: true, allow_google_pay: true });
  const [saving, setSaving] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const qrRef = useRef<HTMLDivElement>(null);

  const fetchConfig = useCallback(async () => {
    const { data } = await supabase.from('qr_booking_config').select('*').limit(1).single();
    if (data) {
      const c = data as unknown as QrConfig;
      setConfig(c);
      setForm({
        pickup_name: c.pickup_name,
        pickup_address: c.pickup_address,
        pickup_lat: String(c.pickup_lat || ''),
        pickup_lng: String(c.pickup_lng || ''),
        status: c.status,
        allow_cash: c.allow_cash,
        allow_card: c.allow_card,
        allow_apple_pay: c.allow_apple_pay,
        allow_google_pay: c.allow_google_pay,
      });
    }
  }, []);

  const fetchAudit = useCallback(async () => {
    const { data } = await supabase
      .from('qr_booking_audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    if (data) setAuditLog(data as unknown as AuditEntry[]);
  }, []);

  useEffect(() => { fetchConfig(); fetchAudit(); }, [fetchConfig, fetchAudit]);

  const validate = () => {
    if (!form.pickup_name.trim()) { toast({ title: 'Validation Error', description: 'Pickup name is required', variant: 'destructive' }); return false; }
    if (!form.pickup_address.trim()) { toast({ title: 'Validation Error', description: 'Pickup address is required', variant: 'destructive' }); return false; }
    const lat = parseFloat(form.pickup_lat);
    const lng = parseFloat(form.pickup_lng);
    if (isNaN(lat) || lat < -90 || lat > 90) { toast({ title: 'Validation Error', description: 'Latitude must be between -90 and 90', variant: 'destructive' }); return false; }
    if (isNaN(lng) || lng < -180 || lng > 180) { toast({ title: 'Validation Error', description: 'Longitude must be between -180 and 180', variant: 'destructive' }); return false; }
    return true;
  };

  const handleSave = async () => {
    if (!validate() || !config) return;
    setSaving(true);

    const oldValues = {
      pickup_name: config.pickup_name,
      pickup_address: config.pickup_address,
      pickup_lat: config.pickup_lat,
      pickup_lng: config.pickup_lng,
      status: config.status,
      allow_cash: config.allow_cash,
      allow_card: config.allow_card,
      allow_apple_pay: config.allow_apple_pay,
      allow_google_pay: config.allow_google_pay,
    };

    const newValues = {
      pickup_name: form.pickup_name.trim(),
      pickup_address: form.pickup_address.trim(),
      pickup_lat: parseFloat(form.pickup_lat),
      pickup_lng: parseFloat(form.pickup_lng),
      status: form.status,
      allow_cash: form.allow_cash,
      allow_card: form.allow_card,
      allow_apple_pay: form.allow_apple_pay,
      allow_google_pay: form.allow_google_pay,
    };

    const { error } = await supabase
      .from('qr_booking_config')
      .update({ ...newValues, updated_by: user?.id })
      .eq('id', config.id);

    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      // Write audit log
      await supabase.from('qr_booking_audit_log').insert({
        changed_by: user?.id,
        changed_by_email: user?.email ?? null,
        old_values: oldValues,
        new_values: newValues,
      });
      toast({ title: 'Saved', description: 'QR Booking configuration updated' });
      fetchConfig();
      fetchAudit();
    }
    setSaving(false);
  };

  const handleStatusToggle = async (checked: boolean) => {
    const newStatus = checked ? 'active' : 'disabled';
    setForm(prev => ({ ...prev, status: newStatus }));
    if (!config) return;

    const { error } = await supabase
      .from('qr_booking_config')
      .update({ status: newStatus, updated_by: user?.id })
      .eq('id', config.id);

    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
      setForm(prev => ({ ...prev, status: config.status })); // revert
      return;
    }

    await supabase.from('qr_booking_audit_log').insert({
      changed_by: user?.id,
      changed_by_email: user?.email ?? null,
      old_values: { status: config.status },
      new_values: { status: newStatus },
    });

    toast({ title: 'Saved', description: `QR Booking ${checked ? 'enabled' : 'disabled'}` });
    fetchConfig();
    fetchAudit();
  };

  const copyUrl = async () => {
    await navigator.clipboard.writeText(QR_URL);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast({ title: 'Copied', description: 'QR URL copied to clipboard' });
  };

  const downloadQr = (format: 'png' | 'svg') => {
    const svgElement = qrRef.current?.querySelector('svg');
    if (!svgElement) return;

    if (format === 'svg') {
      const svgData = new XMLSerializer().serializeToString(svgElement);
      const blob = new Blob([svgData], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'onecab-qr-booking.svg'; a.click();
      URL.revokeObjectURL(url);
    } else {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const svgData = new XMLSerializer().serializeToString(svgElement);
      const img = new Image();
      img.onload = () => {
        canvas.width = 512; canvas.height = 512;
        ctx?.drawImage(img, 0, 0, 512, 512);
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/png');
        a.download = 'onecab-qr-booking.png'; a.click();
      };
      img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
    }
  };

  const isActive = form.status === 'active';

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <QrCode className="h-6 w-6" /> QR Booking Control
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Single source of truth for the global QR guest booking system
          </p>
        </div>
        <Badge variant={isActive ? 'default' : 'secondary'} className="text-sm px-3 py-1">
          {isActive ? 'Active' : 'Disabled'}
        </Badge>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Configuration Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <MapPin className="h-5 w-5" /> Pickup Configuration
            </CardTitle>
            <CardDescription>Configure the fixed pickup location for QR bookings</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="pickup_name">Pickup Name *</Label>
              <Input id="pickup_name" value={form.pickup_name} onChange={e => setForm(p => ({ ...p, pickup_name: e.target.value }))} placeholder="e.g. Milton Keynes Station" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pickup_address">Pickup Address *</Label>
              <Input id="pickup_address" value={form.pickup_address} onChange={e => setForm(p => ({ ...p, pickup_address: e.target.value }))} placeholder="e.g. Elder Gate, Milton Keynes MK9 1EN" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="pickup_lat">Latitude *</Label>
                <Input id="pickup_lat" type="number" step="any" value={form.pickup_lat} onChange={e => setForm(p => ({ ...p, pickup_lat: e.target.value }))} placeholder="52.0347" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pickup_lng">Longitude *</Label>
                <Input id="pickup_lng" type="number" step="any" value={form.pickup_lng} onChange={e => setForm(p => ({ ...p, pickup_lng: e.target.value }))} placeholder="-0.7740" />
              </div>
            </div>

            {/* Status Toggle */}
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label className="text-base">QR Booking Status</Label>
                <p className="text-sm text-muted-foreground">
                  {isActive ? 'Guest bookings via QR are live' : 'Guest bookings via QR are blocked'}
                </p>
              </div>
              <Switch checked={isActive} onCheckedChange={handleStatusToggle} />
            </div>

            {/* Payment Methods */}
            <div className="space-y-3">
              <Label className="text-base">Allowed Payment Methods</Label>
              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">Cash</span>
                  </div>
                  <Switch checked={form.allow_cash} onCheckedChange={v => setForm(p => ({ ...p, allow_cash: v }))} />
                </div>
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">Card</span>
                  </div>
                  <Switch checked={form.allow_card} onCheckedChange={v => setForm(p => ({ ...p, allow_card: v }))} />
                </div>
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">Apple Pay</span>
                  </div>
                  <Switch checked={form.allow_apple_pay} onCheckedChange={v => setForm(p => ({ ...p, allow_apple_pay: v }))} />
                </div>
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">Google Pay</span>
                  </div>
                  <Switch checked={form.allow_google_pay} onCheckedChange={v => setForm(p => ({ ...p, allow_google_pay: v }))} />
                </div>
              </div>
            </div>

            {/* QR URL (readonly) */}
            <div className="space-y-2">
              <Label>QR URL (read-only)</Label>
              <div className="flex gap-2">
                <Input value={QR_URL} readOnly className="bg-muted" />
                <Button variant="outline" size="icon" onClick={copyUrl}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <Button onClick={handleSave} disabled={saving} className="w-full">
              <Save className="h-4 w-4 mr-2" /> {saving ? 'Saving...' : 'Save Configuration'}
            </Button>
          </CardContent>
        </Card>

        {/* QR Code Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <QrCode className="h-5 w-5" /> QR Code Preview
            </CardTitle>
            <CardDescription>Download or share this QR code at pickup locations</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center space-y-6">
            <div ref={qrRef} className="p-6 bg-white rounded-xl border-2 border-border">
              <QRCodeSVG value={QR_URL} size={200} level="H" includeMargin />
            </div>
            <p className="text-xs text-muted-foreground text-center break-all">{QR_URL}</p>
            <div className="flex gap-3 w-full">
              <Button variant="outline" className="flex-1" onClick={() => downloadQr('png')}>
                <Download className="h-4 w-4 mr-2" /> PNG
              </Button>
              <Button variant="outline" className="flex-1" onClick={() => downloadQr('svg')}>
                <Download className="h-4 w-4 mr-2" /> SVG
              </Button>
            </div>

            {/* Status Preview */}
            {!isActive && (
              <div className="w-full rounded-lg bg-destructive/10 border border-destructive/20 p-4 text-center">
                <Shield className="h-5 w-5 text-destructive mx-auto mb-2" />
                <p className="text-sm font-medium text-destructive">QR booking is temporarily unavailable</p>
                <p className="text-xs text-muted-foreground mt-1">This message is shown to guests when disabled</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Audit Log */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <History className="h-5 w-5" /> Change History
          </CardTitle>
          <CardDescription>Audit log of all QR booking configuration changes</CardDescription>
        </CardHeader>
        <CardContent>
          {auditLog.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No changes recorded yet</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>Changes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {auditLog.map(entry => {
                  const changes: string[] = [];
                  const oldV = entry.old_values as Record<string, unknown>;
                  const newV = entry.new_values as Record<string, unknown>;
                  for (const key of Object.keys(newV)) {
                    if (JSON.stringify(oldV[key]) !== JSON.stringify(newV[key])) {
                      changes.push(`${key}: ${String(oldV[key])} → ${String(newV[key])}`);
                    }
                  }
                  return (
                    <TableRow key={entry.id}>
                      <TableCell className="text-xs whitespace-nowrap">{format(new Date(entry.created_at), 'dd MMM yyyy HH:mm')}</TableCell>
                      <TableCell className="text-xs">{entry.changed_by_email || 'System'}</TableCell>
                      <TableCell className="text-xs">
                        {changes.length > 0 ? changes.map((c, i) => <div key={i}>{c}</div>) : <span className="text-muted-foreground">No changes</span>}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
