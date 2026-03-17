import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';

/**
 * Extracts the storage path from a full Supabase storage URL.
 * e.g. "https://xxx.supabase.co/storage/v1/object/public/driver-documents/abc/file.jpg"
 *   → "abc/file.jpg"
 */
function extractStoragePath(fileUrl: string): string | null {
  if (!fileUrl) return null;

  // Handle both /object/public/ and /object/sign/ URL formats
  const patterns = [
    /\/storage\/v1\/object\/(?:public|sign)\/driver-documents\/(.+)/,
    /\/storage\/v1\/object\/driver-documents\/(.+)/,
  ];

  for (const pattern of patterns) {
    const match = fileUrl.match(pattern);
    if (match?.[1]) {
      // Remove any query params from the path
      return match[1].split('?')[0];
    }
  }

  // If it doesn't look like a full URL, treat it as a raw path
  if (!fileUrl.startsWith('http')) {
    return fileUrl;
  }

  return null;
}

/**
 * Generate a signed URL for a file in the private driver-documents bucket.
 * Returns null if the file can't be accessed.
 */
export async function getSignedDocumentUrl(fileUrl: string | null | undefined): Promise<string | null> {
  if (!fileUrl) return null;

  const storagePath = extractStoragePath(fileUrl);
  if (!storagePath) return null;

  try {
    const { data, error } = await supabase.storage
      .from('driver-documents')
      .createSignedUrl(storagePath, 3600); // 1 hour expiry

    if (error) {
      console.error('Failed to create signed URL:', error.message);
      return null;
    }

    return data?.signedUrl || null;
  } catch (err) {
    console.error('Error generating signed URL:', err);
    return null;
  }
}

/**
 * React hook that resolves a file_url from the documents table
 * into a signed URL that the admin can actually view.
 */
export function useSignedUrl(fileUrl: string | null | undefined): {
  signedUrl: string | null;
  isLoading: boolean;
  error: string | null;
} {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!fileUrl) {
      setSignedUrl(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    getSignedDocumentUrl(fileUrl).then((url) => {
      if (cancelled) return;
      if (url) {
        setSignedUrl(url);
      } else {
        setError('Document file could not be loaded');
      }
      setIsLoading(false);
    });

    return () => { cancelled = true; };
  }, [fileUrl]);

  return { signedUrl, isLoading, error };
}

/**
 * Hook to batch-resolve signed URLs for multiple documents.
 * Returns a map of document id → signed URL.
 */
export function useSignedUrls(documents: Array<{ id: string; file_url: string | null }>) {
  const [urlMap, setUrlMap] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const docsWithFiles = documents.filter(d => d.file_url);
    if (docsWithFiles.length === 0) {
      setUrlMap({});
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    Promise.all(
      docsWithFiles.map(async (doc) => {
        const url = await getSignedDocumentUrl(doc.file_url);
        return { id: doc.id, url };
      })
    ).then((results) => {
      if (cancelled) return;
      const map: Record<string, string> = {};
      for (const r of results) {
        if (r.url) map[r.id] = r.url;
      }
      setUrlMap(map);
      setIsLoading(false);
    });

    return () => { cancelled = true; };
  }, [documents.map(d => d.id + d.file_url).join(',')]);

  return { urlMap, isLoading };
}

/**
 * Hook to fetch a driver's profile photo URL from the documents table.
 * Returns a signed URL for the profile_photo document.
 */
export function useDriverProfilePhoto(driverId: string | null | undefined): {
  photoUrl: string | null;
  isLoading: boolean;
} {
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!driverId) {
      setPhotoUrl(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    (async () => {
      try {
        // First check drivers.profile_photo_url
        const { data: driver } = await supabase
          .from('drivers')
          .select('profile_photo_url')
          .eq('id', driverId)
          .single();

        if (!cancelled && driver?.profile_photo_url) {
          const signed = await getSignedDocumentUrl(driver.profile_photo_url);
          if (!cancelled && signed) {
            setPhotoUrl(signed);
            setIsLoading(false);
            return;
          }
        }

        // Fallback: get from documents table
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
          if (!cancelled) {
            setPhotoUrl(signed);
          }
        }
      } catch (err) {
        console.error('Error fetching profile photo:', err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [driverId]);

  return { photoUrl, isLoading };
}
