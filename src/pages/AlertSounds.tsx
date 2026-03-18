import { useState, useRef, useCallback } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Upload, Play, Pause, Trash2, Volume2, Music,
} from 'lucide-react';
import {
  useAlertSounds, DRIVER_EVENT_TYPES, CUSTOMER_EVENT_TYPES,
  type AlertSound,
} from '@/hooks/useAlertSounds';
import { format } from 'date-fns';

function formatBytes(bytes: number | null) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function AudioPlayer({ url }: { url: string }) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const toggle = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio(url);
      audioRef.current.onended = () => setPlaying(false);
    }
    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
    } else {
      audioRef.current.play();
      setPlaying(true);
    }
  }, [url, playing]);

  return (
    <Button variant="ghost" size="icon" onClick={toggle} className="h-8 w-8">
      {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
    </Button>
  );
}

function TargetBadge({ target }: { target: string }) {
  const colors: Record<string, string> = {
    driver: 'bg-blue-100 text-blue-800',
    customer: 'bg-green-100 text-green-800',
    global: 'bg-amber-100 text-amber-800',
  };
  return (
    <Badge variant="outline" className={colors[target] ?? ''}>
      {target.charAt(0).toUpperCase() + target.slice(1)}
    </Badge>
  );
}

export default function AlertSounds() {
  const {
    sounds, mappings, isLoading, uploadSound, toggleSound, deleteSound,
    upsertMapping, removeMapping, getPublicUrl,
  } = useAlertSounds();

  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AlertSound | null>(null);
  const [uploadForm, setUploadForm] = useState({ name: '', targetApp: 'global', file: null as File | null });

  // Mapping state
  const [mapApp, setMapApp] = useState<'driver' | 'customer'>('driver');
  const [mapEvent, setMapEvent] = useState('');
  const [mapSoundId, setMapSoundId] = useState('');

  const eventTypes = mapApp === 'driver' ? DRIVER_EVENT_TYPES : CUSTOMER_EVENT_TYPES;
  const availableSounds = sounds.filter(s => s.is_active && (s.target_app === mapApp || s.target_app === 'global'));

  // Count assignments per sound
  const assignmentCounts = new Map<string, number>();
  mappings.forEach(m => {
    assignmentCounts.set(m.alert_sound_id, (assignmentCounts.get(m.alert_sound_id) ?? 0) + 1);
  });

  const handleUpload = async () => {
    if (!uploadForm.file || !uploadForm.name) return;
    await uploadSound.mutateAsync({
      file: uploadForm.file,
      name: uploadForm.name,
      targetApp: uploadForm.targetApp,
    });
    setUploadForm({ name: '', targetApp: 'global', file: null });
    setUploadOpen(false);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== 'audio/mpeg') {
      alert('Only MP3 files are accepted.');
      e.target.value = '';
      return;
    }
    setUploadForm(f => ({
      ...f,
      file,
      name: f.name || file.name.replace(/\.[^.]+$/, ''),
    }));
  };

  const handleAssign = async () => {
    if (!mapEvent || !mapSoundId) return;
    await upsertMapping.mutateAsync({
      target_app: mapApp,
      event_type: mapEvent,
      alert_sound_id: mapSoundId,
    });
    setMapEvent('');
    setMapSoundId('');
  };

  // Build report data
  const allEvents = [
    ...DRIVER_EVENT_TYPES.map(e => ({ ...e, app: 'driver' as const })),
    ...CUSTOMER_EVENT_TYPES.map(e => ({ ...e, app: 'customer' as const })),
  ];
  const reportRows = allEvents.map(evt => {
    const mapping = mappings.find(m => m.target_app === evt.app && m.event_type === evt.value);
    return {
      app: evt.app,
      eventType: evt.value,
      eventLabel: evt.label,
      soundName: mapping?.alert_sounds?.name ?? '—',
      source: mapping?.is_default ? 'Default' : mapping ? 'Custom' : 'Unset',
      isActive: mapping?.is_active ?? false,
      updatedAt: mapping?.updated_at ?? null,
      mappingId: mapping?.id,
    };
  });

  return (
    <AdminLayout title="Alert Sounds" description="Manage alert sounds and assign them to notification events across Driver and Customer apps.">
      <Tabs defaultValue="library" className="space-y-4">
        <TabsList>
          <TabsTrigger value="library">
            <Music className="h-4 w-4 mr-2" /> Sound Library
          </TabsTrigger>
          <TabsTrigger value="mapping">
            <Volume2 className="h-4 w-4 mr-2" /> Event Mapping
          </TabsTrigger>
          <TabsTrigger value="report">
            <Volume2 className="h-4 w-4 mr-2" /> Alerting Report
          </TabsTrigger>
        </TabsList>

        {/* ─── LIBRARY TAB ─── */}
        <TabsContent value="library" className="space-y-4">
          <div className="flex justify-between items-center">
            <p className="text-sm text-muted-foreground">
              {sounds.length} sound{sounds.length !== 1 ? 's' : ''} in library
            </p>
            <Button onClick={() => setUploadOpen(true)}>
              <Upload className="h-4 w-4 mr-2" /> Upload Sound
            </Button>
          </div>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">Play</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Target App</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Assignments</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Uploaded</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Loading…</TableCell></TableRow>
                  ) : sounds.length === 0 ? (
                    <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">No sounds uploaded yet.</TableCell></TableRow>
                  ) : sounds.map(s => (
                    <TableRow key={s.id}>
                      <TableCell><AudioPlayer url={getPublicUrl(s.storage_path)} /></TableCell>
                      <TableCell className="font-medium">{s.name}</TableCell>
                      <TableCell><TargetBadge target={s.target_app} /></TableCell>
                      <TableCell>{formatBytes(s.file_size)}</TableCell>
                      <TableCell>{assignmentCounts.get(s.id) ?? 0}</TableCell>
                      <TableCell>
                        <Switch
                          checked={s.is_active}
                          onCheckedChange={(v) => toggleSound.mutate({ id: s.id, is_active: v })}
                        />
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {format(new Date(s.created_at), 'dd MMM yyyy')}
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => setDeleteTarget(s)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── MAPPING TAB ─── */}
        <TabsContent value="mapping" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Assign Sound to Event</CardTitle>
              <CardDescription>Select an app, event type, and sound to create or replace the active mapping.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Target App</Label>
                  <Select value={mapApp} onValueChange={(v) => { setMapApp(v as any); setMapEvent(''); }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="driver">Driver App</SelectItem>
                      <SelectItem value="customer">Customer App</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Event Type</Label>
                  <Select value={mapEvent} onValueChange={setMapEvent}>
                    <SelectTrigger><SelectValue placeholder="Select event…" /></SelectTrigger>
                    <SelectContent>
                      {eventTypes.map(e => (
                        <SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Sound</Label>
                  <Select value={mapSoundId} onValueChange={setMapSoundId}>
                    <SelectTrigger><SelectValue placeholder="Select sound…" /></SelectTrigger>
                    <SelectContent>
                      {availableSounds.map(s => (
                        <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Button onClick={handleAssign} disabled={!mapEvent || !mapSoundId || upsertMapping.isPending}>
                Assign Sound
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Current Mappings</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>App</TableHead>
                    <TableHead>Event</TableHead>
                    <TableHead>Sound</TableHead>
                    <TableHead>Play</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mappings.length === 0 ? (
                    <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No mappings configured.</TableCell></TableRow>
                  ) : mappings.map(m => (
                    <TableRow key={m.id}>
                      <TableCell><TargetBadge target={m.target_app} /></TableCell>
                      <TableCell className="capitalize">{m.event_type.replace(/_/g, ' ')}</TableCell>
                      <TableCell>{m.alert_sounds?.name ?? '—'}</TableCell>
                      <TableCell>
                        {m.alert_sounds && <AudioPlayer url={getPublicUrl(m.alert_sounds.storage_path)} />}
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => removeMapping.mutate(m.id)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── REPORT TAB ─── */}
        <TabsContent value="report">
          <Card>
            <CardHeader>
              <CardTitle>Current Alerting Report</CardTitle>
              <CardDescription>Full overview of all event types and their assigned sounds.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>App</TableHead>
                    <TableHead>Event Type</TableHead>
                    <TableHead>Assigned Sound</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Active</TableHead>
                    <TableHead>Last Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reportRows.map(r => (
                    <TableRow key={`${r.app}-${r.eventType}`}>
                      <TableCell><TargetBadge target={r.app} /></TableCell>
                      <TableCell>{r.eventLabel}</TableCell>
                      <TableCell className="font-medium">{r.soundName}</TableCell>
                      <TableCell>
                        <Badge variant={r.source === 'Custom' ? 'default' : 'outline'}>
                          {r.source}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {r.source !== 'Unset' ? (
                          <Badge variant={r.isActive ? 'default' : 'secondary'}>
                            {r.isActive ? 'Active' : 'Inactive'}
                          </Badge>
                        ) : '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {r.updatedAt ? format(new Date(r.updatedAt), 'dd MMM yyyy HH:mm') : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Upload Dialog */}
      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload Alert Sound</DialogTitle>
            <DialogDescription>Upload an MP3 file to the alert sound library.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Sound Name</Label>
              <Input
                value={uploadForm.name}
                onChange={e => setUploadForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Ride Offer Chime"
              />
            </div>
            <div className="space-y-2">
              <Label>Target App</Label>
              <Select value={uploadForm.targetApp} onValueChange={v => setUploadForm(f => ({ ...f, targetApp: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Global (Both Apps)</SelectItem>
                  <SelectItem value="driver">Driver App</SelectItem>
                  <SelectItem value="customer">Customer App</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>MP3 File</Label>
              <Input type="file" accept="audio/mpeg,.mp3" onChange={handleFileChange} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadOpen(false)}>Cancel</Button>
            <Button onClick={handleUpload} disabled={!uploadForm.file || !uploadForm.name || uploadSound.isPending}>
              {uploadSound.isPending ? 'Uploading…' : 'Upload'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Sound</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{deleteTarget?.name}" and remove all its event mappings. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) {
                  deleteSound.mutate({ id: deleteTarget.id, storagePath: deleteTarget.storage_path });
                  setDeleteTarget(null);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminLayout>
  );
}
