/**
 * #111E — in-memory ledger fake compatible with creditCapturedCardTripLedger
 * (trips model probe + TEN readback chain + pending release + insert).
 */
export type TerminalLedgerFakeRow = {
  id: string;
  driver_id: string;
  related_trip_id: string;
  type: string;
  amount_pence: number;
};

export function createTerminalLedgerFake() {
  const rows: TerminalLedgerFakeRow[] = [];
  let inserts = 0;

  const supabase = {
    from(table: string) {
      if (table === "trips") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: () => Promise.resolve({ data: null, error: null }),
                };
              },
            };
          },
        };
      }
      if (table !== "driver_wallet_ledger") {
        throw new Error(`unexpected table ${table}`);
      }
      const filters: Record<string, string> = {};
      const matchedRows = () =>
        rows.filter((row) => {
          if (filters.related_trip_id && row.related_trip_id !== filters.related_trip_id) {
            return false;
          }
          if (filters.type && row.type !== filters.type) return false;
          return true;
        });
      const result = () =>
        Promise.resolve({
          data: matchedRows().map((row) => ({
            id: row.id,
            type: row.type,
            amount_pence: row.amount_pence,
            driver_id: row.driver_id,
          })),
          error: null,
        });
      const api: Record<string, unknown> = {
        select() {
          return api;
        },
        eq(key: string, value: string) {
          filters[key] = value;
          return api;
        },
        in() {
          return Promise.resolve({
            data: matchedRows().map((row) => ({ type: row.type, id: row.id })),
            error: null,
          });
        },
        maybeSingle() {
          const matched = matchedRows()[0];
          return Promise.resolve({
            data: matched
              ? {
                id: matched.id,
                type: matched.type,
                amount_pence: matched.amount_pence,
                driver_id: matched.driver_id,
              }
              : null,
            error: null,
          });
        },
        insert(
          row: Omit<TerminalLedgerFakeRow, "id"> & {
            metadata?: unknown;
            description?: string;
            currency?: string;
          },
        ) {
          inserts += 1;
          const duplicate = rows.some(
            (existing) =>
              existing.related_trip_id === row.related_trip_id &&
              existing.type === row.type,
          );
          if (duplicate) return Promise.resolve({ error: { code: "23505" } });
          rows.push({
            id: `row-${rows.length + 1}`,
            driver_id: row.driver_id,
            related_trip_id: row.related_trip_id,
            type: row.type,
            amount_pence: row.amount_pence,
          });
          return Promise.resolve({ error: null });
        },
        then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
          return result().then(onFulfilled, onRejected);
        },
      };
      return api;
    },
  };

  return { supabase: supabase as never, rows, insertCount: () => inserts };
}
