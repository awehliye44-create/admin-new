-- Add 'legal' to app_scope enum for legal content sections
ALTER TYPE public.app_scope ADD VALUE IF NOT EXISTS 'legal';
