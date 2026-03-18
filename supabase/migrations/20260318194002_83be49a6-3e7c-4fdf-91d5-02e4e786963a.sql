
-- Fix the security definer view warning by making it SECURITY INVOKER explicitly
ALTER VIEW public.user_directory SET (security_invoker = on);
