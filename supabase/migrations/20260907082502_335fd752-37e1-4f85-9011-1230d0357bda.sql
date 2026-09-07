CREATE POLICY "Admins can delete driver documents"
ON storage.objects
FOR DELETE
TO authenticated
USING (bucket_id = 'driver-documents' AND public.has_role(auth.uid(), 'admin'::public.app_role));