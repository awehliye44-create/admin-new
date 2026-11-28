/** Admin presentation-only helpers; not part of Edge uploads. */


/** True when PS must not treat the value as an amount-FR conclusion chip. */
export function isPaymentSessionsAmountsOnFrStatus(
  status: string | null | undefined,
): boolean {
  return status == null || status === "" || status === "AMOUNTS_ON_FR";
}
