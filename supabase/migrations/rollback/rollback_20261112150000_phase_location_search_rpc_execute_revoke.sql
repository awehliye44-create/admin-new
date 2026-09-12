-- Restores grants observed 2026-09-12. Does not change function bodies.

BEGIN;

GRANT EXECUTE ON FUNCTION public.search_places(text, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_places(text, uuid, integer) TO service_role;

GRANT EXECUTE ON FUNCTION public.search_onecab_location_landmarks(text, uuid, text, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_onecab_location_landmarks(text, uuid, text, uuid, integer) TO service_role;

COMMIT;
