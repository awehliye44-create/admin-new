import { useState, useEffect } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getSignedDocumentUrl } from '@/hooks/useDriverFileUrl';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';

interface DriverAvatarProps {
  driverId: string;
  profilePhotoUrl: string | null;
  firstName: string;
  lastName: string;
  className?: string;
  fallbackClassName?: string;
}

/**
 * Smart driver avatar that resolves profile photos from:
 * 1. drivers.profile_photo_url (signed URL if private bucket)
 * 2. documents table (profile_photo type) as fallback
 * Shows initials if no photo is available.
 */
export function DriverAvatar({
  driverId,
  profilePhotoUrl,
  firstName,
  lastName,
  className,
  fallbackClassName,
}: DriverAvatarProps) {
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Try the profile_photo_url first
      if (profilePhotoUrl) {
        const signed = await getSignedDocumentUrl(profilePhotoUrl);
        if (!cancelled && signed) {
          setResolvedUrl(signed);
          return;
        }
      }

      // Fallback: look for profile_photo document
      const { data: doc } = await supabase
        .from('documents')
        .select('file_url')
        .eq('driver_id', driverId)
        .eq('document_type', 'profile_photo')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!cancelled && doc?.file_url) {
        const signed = await getSignedDocumentUrl(doc.file_url);
        if (!cancelled && signed) {
          setResolvedUrl(signed);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [driverId, profilePhotoUrl]);

  return (
    <Avatar className={cn('h-9 w-9 border border-border', className)}>
      <AvatarImage src={resolvedUrl || ''} />
      <AvatarFallback className={cn('bg-primary/10 text-primary text-xs', fallbackClassName)}>
        {firstName?.[0]}{lastName?.[0]}
      </AvatarFallback>
    </Avatar>
  );
}
