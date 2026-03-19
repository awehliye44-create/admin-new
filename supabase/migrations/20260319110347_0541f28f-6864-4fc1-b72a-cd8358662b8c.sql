-- Fix security definer view issue by setting security_invoker = true
ALTER VIEW public.driver_financial_summary SET (security_invoker = true);