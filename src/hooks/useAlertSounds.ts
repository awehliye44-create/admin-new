import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';

export interface AlertSound {
  id: string;
  name: string;
  storage_path: string;
  mime_type: string;
  file_size: number | null;
  duration: number | null;
  target_app: 'driver' | 'customer' | 'global';
  is_active: boolean;
  created_at: string;
  updated_at: string;
  assignment_count?: number;
}

export interface AlertSoundMapping {
  id: string;
  target_app: 'driver' | 'customer';
  event_type: string;
  alert_sound_id: string;
  is_default: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  alert_sounds?: AlertSound;
}

export const DRIVER_EVENT_TYPES = [
  { value: 'new_ride_offer', label: 'New Ride Offer' },
  { value: 'stacked_ride_offer', label: 'Stacked Ride Offer' },
  { value: 'trip_cancelled', label: 'Trip Cancelled' },
  { value: 'payment_received', label: 'Payment Received' },
  { value: 'message_received', label: 'Message Received' },
  { value: 'warning', label: 'Warning' },
] as const;

export const CUSTOMER_EVENT_TYPES = [
  { value: 'driver_assigned', label: 'Driver Assigned' },
  { value: 'driver_arrived', label: 'Driver Arrived' },
  { value: 'trip_started', label: 'Trip Started' },
  { value: 'trip_completed', label: 'Trip Completed' },
  { value: 'trip_cancelled', label: 'Trip Cancelled' },
  { value: 'message_received', label: 'Message Received' },
  { value: 'payment_status', label: 'Payment Status' },
  { value: 'general_notification', label: 'General Notification' },
] as const;

export function useAlertSounds() {
  const queryClient = useQueryClient();

  const soundsQuery = useQuery({
    queryKey: ['alert-sounds'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('alert_sounds')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as AlertSound[];
    },
  });

  const mappingsQuery = useQuery({
    queryKey: ['alert-sound-mappings'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('alert_sound_mappings')
        .select('*, alert_sounds(*)')
        .order('target_app')
        .order('event_type');
      if (error) throw error;
      return data as AlertSoundMapping[];
    },
  });

  const uploadSound = useMutation({
    mutationFn: async ({ file, name, targetApp }: { file: File; name: string; targetApp: string }) => {
      const ext = file.name.split('.').pop();
      const path = `${crypto.randomUUID()}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from('alert-sounds')
        .upload(path, file, { contentType: 'audio/mpeg' });
      if (uploadError) throw uploadError;

      const { error: dbError } = await supabase
        .from('alert_sounds')
        .insert({
          name,
          storage_path: path,
          mime_type: 'audio/mpeg',
          file_size: file.size,
          target_app: targetApp,
        });
      if (dbError) throw dbError;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alert-sounds'] });
      toast({ title: 'Sound uploaded successfully' });
    },
    onError: (err: Error) => {
      toast({ title: 'Upload failed', description: err.message, variant: 'destructive' });
    },
  });

  const toggleSound = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase
        .from('alert_sounds')
        .update({ is_active })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alert-sounds'] });
    },
  });

  const deleteSound = useMutation({
    mutationFn: async ({ id, storagePath }: { id: string; storagePath: string }) => {
      await supabase.storage.from('alert-sounds').remove([storagePath]);
      const { error } = await supabase.from('alert_sounds').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alert-sounds'] });
      queryClient.invalidateQueries({ queryKey: ['alert-sound-mappings'] });
      toast({ title: 'Sound deleted' });
    },
  });

  const upsertMapping = useMutation({
    mutationFn: async ({ target_app, event_type, alert_sound_id }: {
      target_app: string; event_type: string; alert_sound_id: string;
    }) => {
      // Use upsert with the unique constraint on (target_app, event_type)
      const { error } = await supabase
        .from('alert_sound_mappings')
        .upsert(
          { target_app, event_type, alert_sound_id, is_active: true },
          { onConflict: 'target_app,event_type' }
        );
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alert-sound-mappings'] });
      toast({ title: 'Mapping updated' });
    },
    onError: (err: Error) => {
      toast({ title: 'Failed to update mapping', description: err.message, variant: 'destructive' });
    },
  });

  const removeMapping = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('alert_sound_mappings').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alert-sound-mappings'] });
      toast({ title: 'Mapping removed' });
    },
  });

  const getPublicUrl = (storagePath: string) => {
    const { data } = supabase.storage.from('alert-sounds').getPublicUrl(storagePath);
    return data.publicUrl;
  };

  return {
    sounds: soundsQuery.data ?? [],
    mappings: mappingsQuery.data ?? [],
    isLoading: soundsQuery.isLoading || mappingsQuery.isLoading,
    uploadSound,
    toggleSound,
    deleteSound,
    upsertMapping,
    removeMapping,
    getPublicUrl,
  };
}
