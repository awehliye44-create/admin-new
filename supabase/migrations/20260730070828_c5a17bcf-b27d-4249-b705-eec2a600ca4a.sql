INSERT INTO public.role_page_permissions (page_slug, role, can_access)
SELECT s.slug, p.role, p.can_access
FROM (VALUES ('help-centre'),('driver-special-offers')) AS s(slug)
CROSS JOIN LATERAL (SELECT role, can_access FROM public.role_page_permissions WHERE page_slug = 'content') p
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_page_permissions r WHERE r.page_slug = s.slug AND r.role = p.role
);