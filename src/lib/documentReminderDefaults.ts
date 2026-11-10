/** Default document-expiry reminder schedule (days before expiry). */
export const DEFAULT_DOCUMENT_REMINDER_DAYS: readonly number[] = [7, 3, 1];

export const DEFAULT_DOCUMENT_REMINDER_DAYS_INPUT = DEFAULT_DOCUMENT_REMINDER_DAYS.join(",");

/** Form value for a document type's reminder schedule; falls back to the default when none is saved. */
export function reminderDaysInputValue(days: readonly number[] | null | undefined): string {
  return days && days.length > 0 ? days.join(",") : DEFAULT_DOCUMENT_REMINDER_DAYS_INPUT;
}
