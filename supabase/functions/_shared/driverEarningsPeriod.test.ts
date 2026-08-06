import {
  computeNextRunAtUtc,
  periodsAbut,
  resolveEveryNMonthsPeriod,
} from "./driverEarningsPeriod.ts";

Deno.test("eight-month interval creates expected window", () => {
  const asOf = new Date(Date.UTC(2026, 7, 6)); // 2026-08-06
  const p = resolveEveryNMonthsPeriod(asOf, 8);
  if (p.periodStartInclusive !== "2025-12-06") {
    throw new Error(`start ${p.periodStartInclusive}`);
  }
  if (p.periodEndExclusive !== "2026-08-06") {
    throw new Error(`endExclusive ${p.periodEndExclusive}`);
  }
  if (p.nextPeriodStartInclusive !== "2026-08-06") {
    throw new Error(`next ${p.nextPeriodStartInclusive}`);
  }
});

Deno.test("another interval works without code changes", () => {
  const asOf = new Date(Date.UTC(2026, 0, 15));
  const p3 = resolveEveryNMonthsPeriod(asOf, 3);
  if (p3.periodStartInclusive !== "2025-10-15") throw new Error(p3.periodStartInclusive);
  if (p3.periodEndExclusive !== "2026-01-15") throw new Error(p3.periodEndExclusive);
});

Deno.test("consecutive periods do not overlap", () => {
  const firstAsOf = new Date(Date.UTC(2026, 7, 6)); // 2026-08-06
  const first = resolveEveryNMonthsPeriod(firstAsOf, 8);
  const secondAsOf = new Date(Date.UTC(2027, 3, 6)); // 2027-04-06 (+8 months)
  const second = resolveEveryNMonthsPeriod(secondAsOf, 8);
  if (second.periodStartInclusive !== first.periodEndExclusive) {
    throw new Error(
      `overlap/gap: first ends ${first.periodEndExclusive}, second starts ${second.periodStartInclusive}`,
    );
  }
  if (!periodsAbut(first, second)) {
    throw new Error("periodsAbut failed");
  }
});

Deno.test("next run advances by interval months", () => {
  const from = new Date(Date.UTC(2026, 0, 5, 9, 0, 0));
  const next = computeNextRunAtUtc(from, 8, 5, 9);
  if (next.getUTCFullYear() !== 2026 || next.getUTCMonth() !== 8 || next.getUTCDate() !== 5) {
    throw new Error(next.toISOString());
  }
});
