INSERT INTO public.user_roles (user_id, role)
VALUES ('abf3f4f6-a559-4df0-906b-3b797660a697', 'admin')
ON CONFLICT (user_id, role) DO NOTHING;