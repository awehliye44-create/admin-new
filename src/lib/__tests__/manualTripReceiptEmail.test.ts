import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  coveringAuthorisedHoldPence,
  normalizeReceiptEmail,
  receiptEmailBadgeLabel,
  receiptSendClaimDecision,
  resolveReceiptEmailBadge,
} from '../../../shared/manualTripReceiptSSOT';

const ROOT = path.join(__dirname, '../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('manual trip receipt email', () => {
  it('validates a single email and rejects empty or malformed values', () => {
    expect(normalizeReceiptEmail('  Ada@Onecab.net ')).toBe('ada@onecab.net');
    expect(normalizeReceiptEmail('')).toBeNull();
    expect(normalizeReceiptEmail('not-an-email')).toBeNull();
    expect(normalizeReceiptEmail('a y@onecab.net')).toBeNull();
  });

  it('shows Sent only from email evidence, never from trip completion alone', () => {
    expect(resolveReceiptEmailBadge({})).toBe('not_sent');
    expect(resolveReceiptEmailBadge({ invoice_email_status: 'failed' })).toBe('failed');
    expect(resolveReceiptEmailBadge({ invoice_email_status: 'sending' })).toBe('sending');
    expect(resolveReceiptEmailBadge({ requestInProgress: true })).toBe('sending');
    expect(resolveReceiptEmailBadge({ invoice_email_sent_at: '2026-09-14T12:00:00Z' })).toBe('sent');
    expect(resolveReceiptEmailBadge({ invoice_email_status: 'sent' })).toBe('sent');
    expect(resolveReceiptEmailBadge({ invoice_email_log_status: 'sent' })).toBe('sent');
    expect(resolveReceiptEmailBadge({ invoice_email_log_status: 'failed' })).toBe('failed');
    expect(resolveReceiptEmailBadge({
      invoice_email_status: 'failed',
      invoice_email_log_status: 'sent',
      invoice_email_log_sent_at: '2026-09-14T12:00:00Z',
    })).toBe('sent');
    expect(resolveReceiptEmailBadge({
      invoice_email_status: 'sent',
      invoice_email_sent_at: '2026-09-14T11:00:00Z',
      invoice_email_log_status: 'failed',
    })).toBe('failed');
    expect(resolveReceiptEmailBadge({
      invoice_email_sent_at: '2026-09-14T12:00:00Z',
      invoice_email_log_status: 'sending',
    })).toBe('sent');
    expect(receiptEmailBadgeLabel('not_sent')).toBe('Not sent');
    expect(receiptEmailBadgeLabel('sending')).toBe('Sending…');
  });

  it('accepts a covering card hold during the tip window without treating a failed hold as settled', () => {
    expect(coveringAuthorisedHoldPence([
      { status: 'authorised', authorised_amount_pence: 1290 },
    ], 1290)).toBe(1290);
    expect(coveringAuthorisedHoldPence([
      { status: 'declined', authorised_amount_pence: 1290 },
    ], 1290)).toBe(0);
    expect(coveringAuthorisedHoldPence([
      { status: 'authorised', authorised_amount_pence: 500 },
    ], 1290)).toBe(0);
  });

  it('treats a rapid second tap as in progress or already sent', () => {
    const now = Date.parse('2026-09-14T12:00:10Z');
    expect(receiptSendClaimDecision({
      inflightUpdatedAt: '2026-09-14T12:00:00Z',
      recipient: 'ada@onecab.net',
      nowMs: now,
    })).toBe('in_progress');
    expect(receiptSendClaimDecision({
      recentSentAt: '2026-09-14T12:00:00Z',
      recentSentRecipient: 'ada@onecab.net',
      recipient: 'Ada@Onecab.net',
      nowMs: now,
    })).toBe('already_sent');
    expect(receiptSendClaimDecision({
      recentSentAt: '2026-09-14T11:00:00Z',
      recentSentRecipient: 'ada@onecab.net',
      recipient: 'ada@onecab.net',
      nowMs: now,
    })).toBe('send');
  });

  it('does not email from completion, capture, sweep, or generate', () => {
    const trigger = read('supabase/functions/_shared/tripInvoiceTrigger.ts');
    const process = read('supabase/functions/trip-invoice-process/index.ts');
    const invoice = read('supabase/functions/_shared/tripInvoice.ts');
    const service = read('supabase/functions/_shared/tripInvoiceService.ts');
    const sql = read('supabase/migrations/20261109630000_manual_trip_receipt_email.sql');
    const sweep = read('supabase/functions/sweep-pending-trip-invoices/index.ts');
    const endpoint = read('supabase/functions/send-trip-receipt/index.ts');
    const sender = read('supabase/functions/_shared/manualTripReceiptSend.ts');

    expect(trigger).toContain('generate_only');
    expect(trigger).not.toContain('"auto"');
    expect(process).toContain('generate_only');
    expect(process).not.toContain('handleTripInvoiceAction(supabase, row.id as string, "generate")');
    expect(invoice).toContain('Receipt email is send-trip-receipt only');
    expect(invoice).toContain('const shouldEmail = false');
    expect(invoice).not.toContain('action === "generate" && !updated.invoice_email_sent');
    expect(service).toContain('Receipt email is sent only after a manual request');
    expect(service).not.toContain('return sendInvoiceEmail(supabase, updated, false)');
    expect(service).not.toContain('return sendInvoiceEmail(supabase, updated, true)');
    expect(service).toContain('Receipt email requires a manual customer or admin action');
    expect(sql).toContain("invoke_trip_invoice_process(NEW.id, 'generate_only')");
    expect(sql).toContain('manual_receipt_only');
    expect(sql).not.toContain("'generate')");
    expect(sweep).not.toContain('maybeInvokeAutoTripInvoice');
    expect(endpoint).toContain('token === serviceKey');
    expect(process).toContain('Receipt email requires a manual customer or admin action');
    expect(sender).toContain('fetchTrip(supabase, args.tripId)');
    expect(sender).not.toContain('.eq("stacked_trip_id"');
    expect(sender).toContain('coveringAuthorisedHoldPence');
    expect(sender).toContain('authorisedHoldPence');
  });
});
