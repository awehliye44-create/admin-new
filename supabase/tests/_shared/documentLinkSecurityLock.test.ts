/**
 * LOCK — document link security (20270305280000).
 *
 * Anonymous clients must not read the compliance view.
 * Internal eligibility and vehicle-document helpers are not client RPCs.
 * New vehicle documents are not guessed onto primary/oldest.
 * A driver update cannot change driver_id or vehicle_id.
 *
 * Run: deno test --allow-read supabase/tests/_shared/documentLinkSecurityLock.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIG = new URL(
  "../../migrations/20270305280000_document_link_security.sql",
  import.meta.url,
);

function fnBody(sql: string, name: string): string {
  const needle = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const start = sql.indexOf(needle);
  assert(start >= 0, `${name} missing`);
  const end = sql.indexOf("\n$$;", start);
  assert(end > start, `${name} body not terminated`);
  return sql.slice(start, end);
}

Deno.test("compliance view is security invoker and anonymous select is revoked", async () => {
  const sql = await Deno.readTextFile(MIG);
  assert(sql.includes("ALTER VIEW public.driver_document_compliance_ssot SET (security_invoker = on)"));
  assert(sql.includes("REVOKE ALL ON TABLE public.driver_document_compliance_ssot FROM PUBLIC, anon"));
  assert(sql.includes("GRANT SELECT ON TABLE public.driver_document_compliance_ssot TO authenticated, service_role"));
  assert(sql.includes("t.vehicle_id IS NOT NULL"));
  assert(sql.includes("AND d.vehicle_id = t.vehicle_id"));
  assertEquals(
    sql.includes("GRANT SELECT ON TABLE public.driver_document_compliance_ssot TO anon"),
    false,
  );
  assertEquals(
    sql.includes("GRANT ALL ON TABLE public.driver_document_compliance_ssot"),
    false,
  );
});

Deno.test("internal helpers are not executable by anon or authenticated clients", async () => {
  const sql = await Deno.readTextFile(MIG);
  assert(sql.includes(
    "REVOKE ALL ON FUNCTION public.vehicle_change_applicable_documents(uuid) FROM PUBLIC, anon, authenticated",
  ));
  assert(sql.includes(
    "REVOKE ALL ON FUNCTION public.get_driver_document_eligibility_internal(uuid) FROM PUBLIC, anon, authenticated",
  ));
  assert(sql.includes(
    "GRANT EXECUTE ON FUNCTION public.get_driver_document_eligibility(uuid) TO authenticated",
  ));
  assert(sql.includes(
    "GRANT EXECUTE ON FUNCTION public.get_my_vehicle_change_applicable_documents() TO authenticated, service_role",
  ));
  assert(sql.includes(
    "GRANT EXECUTE ON FUNCTION public.get_driver_document_compliance(uuid) TO authenticated, service_role",
  ));
  assertEquals(
    /GRANT EXECUTE ON FUNCTION public\.vehicle_change_applicable_documents\(uuid\) TO authenticated/.test(sql),
    false,
  );
  assertEquals(
    /GRANT EXECUTE ON FUNCTION public\.get_driver_document_eligibility_internal\(uuid\) TO authenticated/.test(sql),
    false,
  );
  assertEquals(/GRANT EXECUTE ON FUNCTION public\.vehicle_change_applicable_documents\(uuid\) TO anon/.test(sql), false);
});

Deno.test("vehicle target resolution does not guess primary or oldest", async () => {
  const sql = await Deno.readTextFile(MIG);
  const resolve = fnBody(sql, "resolve_vehicle_document_target");
  assert(resolve.includes("status = 'pending'"));
  assert(resolve.includes("requested_vehicle_id IS NOT NULL"));
  assert(resolve.includes("v.is_trip_active = true"));
  assertEquals(resolve.includes("is_primary"), false);
  assertEquals(resolve.includes("created_at ASC"), false);
  assert(resolve.includes("RETURN v_id"));

  const stamp = fnBody(sql, "trg_documents_stamp_vehicle_id");
  assert(stamp.includes("resolve_vehicle_document_target"));
  assert(stamp.includes("NEW.vehicle_id := NULL"));
  assert(stamp.includes("NEW.ambiguity_review_required := true"));
  assert(stamp.includes("assert_document_vehicle_ownership"));
  assertEquals(stamp.includes("is_primary"), false);
});

Deno.test("driver updates cannot change document driver_id or vehicle_id", async () => {
  const sql = await Deno.readTextFile(MIG);
  const freeze = fnBody(sql, "trg_documents_freeze_vehicle_link");
  assert(freeze.includes("DOCUMENT_LINK_IMMUTABLE"));
  assert(freeze.includes("OLD.driver_id IS NOT DISTINCT FROM NEW.driver_id"));
  assert(freeze.includes("OLD.vehicle_id IS NOT DISTINCT FROM NEW.vehicle_id"));
  assert(freeze.includes("staff_has_any_page_access"));
  assert(freeze.includes("onecab.admin_page_mutate"));
  assert(sql.includes("BEFORE UPDATE OF driver_id, vehicle_id ON public.documents"));
  assert(sql.includes("documents_freeze_vehicle_link"));
});

Deno.test("eligibility ignores unlinked vehicle documents when no trip-active vehicle exists", async () => {
  const sql = await Deno.readTextFile(MIG);
  assert(sql.includes(
    "public.resolve_trip_active_vehicle_id(p_driver_id) IS NOT NULL AND d.vehicle_id = public.resolve_trip_active_vehicle_id(p_driver_id)",
  ));
});
