INSERT INTO public.staff_profiles (user_id, full_name, username, role, staff_role_id, is_active)
SELECT '9ab3080c-73ef-4c36-b92b-ae8e8f4815f2', 'OneCab Administrator', 'admin', 'super_admin', 'TEMP', true
WHERE NOT EXISTS (SELECT 1 FROM public.staff_profiles WHERE user_id = '9ab3080c-73ef-4c36-b92b-ae8e8f4815f2');