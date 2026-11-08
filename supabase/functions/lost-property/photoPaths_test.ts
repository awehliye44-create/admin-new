import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { filterCasePhotoPaths, isCasePhotoPath, validateCasePhotoPaths } from "./photoPaths.ts";

const CASE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

Deno.test("accepts photos inside the case folder", () => {
  const r = validateCasePhotoPaths([`${CASE}/a.jpg`, ` ${CASE}/sub/b.png `], CASE);
  assertEquals(r, { ok: true, paths: [`${CASE}/a.jpg`, `${CASE}/sub/b.png`] });
});

Deno.test("missing photos become an empty list", () => {
  assertEquals(validateCasePhotoPaths(undefined, CASE), { ok: true, paths: [] });
});

Deno.test("rejects another case's or user's folder", () => {
  assertEquals(validateCasePhotoPaths([`${OTHER}/a.jpg`], CASE).ok, false);
  assertEquals(validateCasePhotoPaths(["some-user-id/a.jpg"], CASE).ok, false);
});

Deno.test("rejects traversal, empty segments and non-strings", () => {
  assertEquals(isCasePhotoPath(`${CASE}/../${OTHER}/a.jpg`, CASE), false);
  assertEquals(isCasePhotoPath(`${CASE}//a.jpg`, CASE), false);
  assertEquals(isCasePhotoPath(`${CASE}/`, CASE), false);
  assertEquals(validateCasePhotoPaths([123], CASE).ok, false);
  assertEquals(validateCasePhotoPaths("x", CASE).ok, false);
});

Deno.test("rejects more than four photos", () => {
  const five = [1, 2, 3, 4, 5].map((n) => `${CASE}/${n}.jpg`);
  assertEquals(validateCasePhotoPaths(five, CASE).ok, false);
});

Deno.test("cleanup filter drops paths outside the case folder", () => {
  assertEquals(
    filterCasePhotoPaths([`${CASE}/a.jpg`, `${OTHER}/b.jpg`, `${CASE}/../x`, null], CASE),
    [`${CASE}/a.jpg`],
  );
});
