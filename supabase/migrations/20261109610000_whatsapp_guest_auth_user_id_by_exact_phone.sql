-- WhatsApp guest reuse must find the auth user who already owns the exact
-- phone. GoTrue GET /admin/users?filter= is an email/name search, not phone.eq.
-- Exact digits only: no last-10, no leading-00 strip.

CREATE OR REPLACE FUNCTION public.auth_user_id_by_exact_phone(p_phone text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'auth', 'public', 'pg_temp'
AS $function$
  SELECT u.id
  FROM auth.users u
  WHERE length(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')) BETWEEN 10 AND 15
    AND u.phone IN (
      p_phone,
      regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'),
      '+' || regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
    )
  ORDER BY u.created_at ASC
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.auth_user_id_by_exact_phone(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_user_id_by_exact_phone(text) FROM anon;
REVOKE ALL ON FUNCTION public.auth_user_id_by_exact_phone(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.auth_user_id_by_exact_phone(text) TO service_role;
