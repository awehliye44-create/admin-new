import { useState, useRef, useCallback } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
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
  Upload, Play, Pause, Square, Trash2, Volume2, Music, RefreshCw, XCircle, Check,
} from 'lucide-react';
import {
  useAlertSounds, DRIVER_EVENT_TYPES, CUSTOMER_EVENT_TYPES,
  type AlertSound,
} from '@/hooks/useAlertSounds';
import { format } from 'date-fns';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

function formatBytes(bytes: number | null) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// Shared audio player with error handling
function AudioPlayer({ url, disabled }: { url: string | null; disabled?: boolean }) {
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const toggle = useCallback(() => {
    if (!url) return;
    if (!audioRef.current) {
      audioRef.current = new Audio(url);
      audioRef.current.onended = () => setPlaying(false);
      audioRef.current.onerror = () => { setPlaying(false); setError(true); };
    }
    if (playing) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setPlaying(false);
    } else {
      setError(false);
      audioRef.current.play().catch(() => setError(true));
      setPlaying(true);
    }
  }, [url, playing]);

  if (error) {
    return (
      <Badge variant="destructive" className="text-xs gap-1">
        <XCircle className="h-3 w-3" /> Error
      </Badge>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggle}
      disabled={disabled || !url}
      className="h-8 gap-1.5 text-xs"
    >
      {playing ? (
        <><Square className="h-3.5 w-3.5" /> Stop</>
      ) : (
        <><Play className="h-3.5 w-3.5" /> Play</>
      )}
    </Button>
  );
}

function AppBadge({ app }: { app: string }) {
  return (
    <Badge
      variant="outline"
      className={app === 'driver'
        ? 'bg-blue-50 text-blue-700 border-blue-200'
        : 'bg-emerald-50 text-emerald-700 border-emerald-200'
      }
    >
      {app === 'driver' ? 'Driver' : 'Customer'}
    </Badge>
  );
}

function StatusBadge({ status }: { status: 'active' | 'missing' | 'not_assigned' }) {
  if (status === 'active') {
    return <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200 gap-1"><Check className="h-3 w-3" /> Active</Badge>;
  }
  if (status === 'missing') {
    return <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" /> Missing</Badge>;
  }
  return <Badge variant="secondary" className="text-muted-foreground">Not assigned</Badge>;
}

interface EventRow {
  app: 'driver' | 'customer';
  eventType: string;
  eventLabel: string;
  soundName: string | null;
  fileName: string | null;
  storagePath: string | null;
  status: 'active' | 'missing' | 'not_assigned';
  updatedAt: string | null;
  mappingId: string | null;
  alertSoundId: string | null;
}

export default function AlertSounds() {
  const {
    sounds, mappings, isLoading, uploadSound, toggleSound, deleteSound,
    upsertMapping, removeMapping, getPublicUrl,
  } = useAlertSounds();

  // Change sound modal
  const [changeTarget, setChangeTarget] = useState<EventRow | null>(null);
  const [selectedSoundId, setSelectedSoundId] = useState('');

  // Upload within change modal
  const [inlineUpload, setInlineUpload] = useState(false);
  const [uploadForm, setUploadForm] = useState({ name: '', targetApp: 'global', file: null as File | null });

  // Library management
  const [deleteTarget, setDeleteTarget] = useState<AlertSound | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);

  // Build unified event rows
  const allEvents: EventRow[] = [
    ...DRIVER_EVENT_TYPES.map(e => {
      const mapping = mappings.find(m => m.target_app === 'driver' && m.event_type === e.value);
      const sound = mapping?.alert_sounds;
      return {
        app: 'driver' as const,
        eventType: e.value,
        eventLabel: e.label,
        soundName: sound?.name ?? null,
        fileName: sound?.storage_path?.split('/').pop() ?? null,
        storagePath: sound?.storage_path ?? null,
        status: (sound ? (sound.is_active ? 'active' : 'missing') : 'not_assigned') as EventRow['status'],
        updatedAt: mapping?.updated_at ?? null,
        mappingId: mapping?.id ?? null,
        alertSoundId: mapping?.alert_sound_id ?? null,
      };
    }),
    ...CUSTOMER_EVENT_TYPES.map(e => {
      const mapping = mappings.find(m => m.target_app === 'customer' && m.event_type === e.value);
      const sound = mapping?.alert_sounds;
      return {
        app: 'customer' as const,
        eventType: e.value,
        eventLabel: e.label,
        soundName: sound?.name ?? null,
        fileName: sound?.storage_path?.split('/').pop() ?? null,
        storagePath: sound?.storage_path ?? null,
        status: (sound ? (sound.is_active ? 'active' : 'missing') : 'not_assigned') as EventRow['status'],
        updatedAt: mapping?.updated_at ?? null,
        mappingId: mapping?.id ?? null,
        alertSoundId: mapping?.alert_sound_id ?? null,
      };
    }),
  ];

  const driverRows = allEvents.filter(r => r.app === 'driver');
  const customerRows = allEvents.filter(r => r.app === 'customer');

  // Available sounds for change modal
  const changeSounds = changeTarget
    ? sounds.filter(s => s.is_active && (s.target_app === changeTarget.app || s.target_app === 'global'))
    : [];

  const handleAssign = async () => {
    if (!changeTarget || !selectedSoundId) return;
    await upsertMapping.mutateAsync({
      target_app: changeTarget.app,
      event_type: changeTarget.eventType,
      alert_sound_id: selectedSoundId,
    });
    setChangeTarget(null);
    setSelectedSoundId('');
  };

  const handleClearMapping = async () => {
    if (!changeTarget?.mappingId) return;
    await removeMapping.mutateAsync(changeTarget.mappingId);
    setChangeTarget(null);
    setSelectedSoundId('');
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const allowedTypes = ['audio/mpeg', 'audio/wav', 'audio/wave', 'audio/x-wav'];
    const allowedExts = ['mp3', 'wav'];
    if (!allowedTypes.includes(file.type) && !allowedExts.includes(ext)) {
      alert('Only MP3 or WAV files are accepted.');
      e.target.value = '';
      return;
    }
    setUploadForm(f => ({
      ...f,
      file,
      name: f.name || file.name.replace(/\.[^.]+$/, ''),
    }));
  };

  const handleInlineUpload = async () => {
    if (!uploadForm.file || !uploadForm.name) return;
    await uploadSound.mutateAsync({
      file: uploadForm.file,
      name: uploadForm.name,
      targetApp: uploadForm.targetApp,
    });
    setUploadForm({ name: '', targetApp: 'global', file: null });
    setInlineUpload(false);
  };

  const handleLibraryUpload = async () => {
    if (!uploadForm.file || !uploadForm.name) return;
    await uploadSound.mutateAsync({
      file: uploadForm.file,
      name: uploadForm.name,
      targetApp: uploadForm.targetApp,
    });
    setUploadForm({ name: '', targetApp: 'global', file: null });
    setUploadOpen(false);
  };

  // Assignment counts for library
  const assignmentCounts = new Map<string, number>();
  mappings.forEach(m => {
    assignmentCounts.set(m.alert_sound_id, (assignmentCounts.get(m.alert_sound_id) ?? 0) + 1);
  });

  const renderEventTable = (rows: EventRow[], appLabel: string) => (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <AppBadge app={rows[0]?.app ?? 'driver'} />
          {appLabel} Events
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Event Type</TableHead>
              <TableHead>Current Sound</TableHead>
              <TableHead>File</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last Updated</TableHead>
              <TableHead className="text-center">Preview</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(r => (
              <TableRow key={`${r.app}-${r.eventType}`}>
                <TableCell className="font-medium">{r.eventLabel}</TableCell>
                <TableCell>{r.soundName ?? <span className="text-muted-foreground italic">Not assigned</span>}</TableCell>
                <TableCell className="text-muted-foreground text-xs font-mono">{r.fileName ?? '—'}</TableCell>
                <TableCell><StatusBadge status={r.status} /></TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {r.updatedAt ? format(new Date(r.updatedAt), 'dd MMM yyyy HH:mm') : '—'}
                </TableCell>
                <TableCell className="text-center">
                  <AudioPlayer
                    url={r.storagePath ? getPublicUrl(r.storagePath) : null}
                    disabled={r.status === 'not_assigned'}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5"
                    onClick={() => {
                      setChangeTarget(r);
                      setSelectedSoundId(r.alertSoundId ?? '');
                      setInlineUpload(false);
                    }}
                  >
                    <RefreshCw className="h-3.5 w-3.5" /> Change
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );

  return (
    <AdminLayout title="Alert Sounds" description="Central control for all alert sounds across Driver and Customer apps. Admin is the sole source of truth.">
      <Tabs defaultValue="alerts" className="space-y-6">
        <TabsList>
          <TabsTrigger value="alerts" className="gap-2">
            <Volume2 className="h-4 w-4" /> Current Alert Sounds
          </TabsTrigger>
          <TabsTrigger value="library" className="gap-2">
            <Music className="h-4 w-4" /> Sound Library
          </TabsTrigger>
        </TabsList>

        {/* ─── CURRENT ALERT SOUNDS (Primary view) ─── */}
        <TabsContent value="alerts" className="space-y-6">
          {isLoading ? (
            <Card><CardContent className="py-12 text-center text-muted-foreground">Loading alert sound data…</CardContent></Card>
          ) : (
            <>
              {renderEventTable(driverRows, 'Driver App')}
              {renderEventTable(customerRows, 'Customer App')}
            </>
          )}
        </TabsContent>

        {/* ─── SOUND LIBRARY ─── */}
        <TabsContent value="library" className="space-y-4">
          <div className="flex justify-between items-center">
            <p className="text-sm text-muted-foreground">
              {sounds.length} sound{sounds.length !== 1 ? 's' : ''} in library
            </p>
            <Button onClick={() => { setUploadOpen(true); setUploadForm({ name: '', targetApp: 'global', file: null }); }}>
              <Upload className="h-4 w-4 mr-2" /> Upload Sound
            </Button>
          </div>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Preview</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Assignments</TableHead>
                    <TableHead>Active</TableHead>
                    <TableHead>Uploaded</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sounds.length === 0 ? (
                    <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">No sounds uploaded yet. Upload your first MP3 or WAV.</TableCell></TableRow>
                  ) : sounds.map(s => (
                    <TableRow key={s.id}>
                      <TableCell><AudioPlayer url={getPublicUrl(s.storage_path)} /></TableCell>
                      <TableCell className="font-medium">{s.name}</TableCell>
                      <TableCell><AppBadge app={s.target_app === 'global' ? 'driver' : s.target_app} />
                        {s.target_app === 'global' && <Badge variant="outline" className="ml-1 bg-amber-50 text-amber-700 border-amber-200">Global</Badge>}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">{formatBytes(s.file_size)}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{assignmentCounts.get(s.id) ?? 0}</Badge>
                      </TableCell>
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
      </Tabs>

      {/* ─── CHANGE SOUND MODAL ─── */}
      <Dialog open={!!changeTarget} onOpenChange={(open) => { if (!open) { setChangeTarget(null); setSelectedSoundId(''); setInlineUpload(false); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Change Alert Sound</DialogTitle>
            <DialogDescription>
              <span className="capitalize">{changeTarget?.app}</span> App → <span className="font-medium">{changeTarget?.eventLabel}</span>
            </DialogDescription>
          </DialogHeader>

          {!inlineUpload ? (
            <div className="space-y-4">
              {/* Current assignment info */}
              {changeTarget?.soundName && (
                <div className="rounded-lg border p-3 bg-muted/30">
                  <p className="text-xs text-muted-foreground mb-1">Currently assigned</p>
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm">{changeTarget.soundName}</span>
                    <AudioPlayer url={changeTarget.storagePath ? getPublicUrl(changeTarget.storagePath) : null} />
                  </div>
                </div>
              )}

              {/* Sound selection */}
              <div className="space-y-2">
                <Label>Select Sound</Label>
                {changeSounds.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No sounds available. Upload one first.</p>
                ) : (
                  <div className="max-h-60 overflow-y-auto rounded-lg border divide-y">
                    {changeSounds.map(s => (
                      <label
                        key={s.id}
                        className={`flex items-center justify-between px-3 py-2.5 cursor-pointer transition-colors hover:bg-muted/50 ${selectedSoundId === s.id ? 'bg-primary/5 border-l-2 border-l-primary' : ''}`}
                      >
                        <div className="flex items-center gap-3">
                          <input
                            type="radio"
                            name="sound-select"
                            value={s.id}
                            checked={selectedSoundId === s.id}
                            onChange={() => setSelectedSoundId(s.id)}
                            className="accent-[hsl(var(--primary))]"
                          />
                          <div>
                            <p className="text-sm font-medium">{s.name}</p>
                            <p className="text-xs text-muted-foreground">{formatBytes(s.file_size)}</p>
                          </div>
                        </div>
                        <AudioPlayer url={getPublicUrl(s.storage_path)} />
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setInlineUpload(true)}>
                <Upload className="h-3.5 w-3.5" /> Upload New Sound
              </Button>
            </div>
          ) : (
            /* Inline upload form */
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
                    <SelectItem value="driver">Driver App Only</SelectItem>
                    <SelectItem value="customer">Customer App Only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Audio File (MP3 or WAV)</Label>
                <Input type="file" accept="audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" onChange={handleFileChange} />
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => { setInlineUpload(false); setUploadForm({ name: '', targetApp: 'global', file: null }); }}>
                  Back to Library
                </Button>
                <Button size="sm" onClick={handleInlineUpload} disabled={!uploadForm.file || !uploadForm.name || uploadSound.isPending}>
                  {uploadSound.isPending ? 'Uploading…' : 'Upload & Add to Library'}
                </Button>
              </div>
            </div>
          )}

          <DialogFooter className="flex-col sm:flex-row gap-2">
            {changeTarget?.mappingId && (
              <Button variant="destructive" size="sm" onClick={handleClearMapping} disabled={removeMapping.isPending} className="mr-auto">
                Clear Mapping
              </Button>
            )}
            <Button variant="outline" onClick={() => { setChangeTarget(null); setSelectedSoundId(''); }}>
              Cancel
            </Button>
            <Button onClick={handleAssign} disabled={!selectedSoundId || upsertMapping.isPending}>
              {upsertMapping.isPending ? 'Saving…' : 'Assign Sound'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── LIBRARY UPLOAD DIALOG ─── */}
      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload Alert Sound</DialogTitle>
            <DialogDescription>Upload an MP3 or WAV file to the alert sound library.</DialogDescription>
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
                  <SelectItem value="driver">Driver App Only</SelectItem>
                  <SelectItem value="customer">Customer App Only</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Audio File (MP3 or WAV)</Label>
              <Input type="file" accept="audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" onChange={handleFileChange} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadOpen(false)}>Cancel</Button>
            <Button onClick={handleLibraryUpload} disabled={!uploadForm.file || !uploadForm.name || uploadSound.isPending}>
              {uploadSound.isPending ? 'Uploading…' : 'Upload'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── DELETE CONFIRM ─── */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Sound</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{deleteTarget?.name}" and remove all its event mappings. This cannot be undone.
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
