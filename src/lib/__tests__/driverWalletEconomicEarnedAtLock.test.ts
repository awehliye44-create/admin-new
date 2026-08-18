import { describe, expect, it } from 'vitest';
import { buildDriverWalletPeriodKpis } from '@shared/driverWalletPeriodKpisSSOT';
import {
  buildDriverWalletPeriodSummary,
  buildDriverWalletSummaryResponse,
} from '@/lib/driverWalletPeriodWidgetsSSOT';
import { getLondonDayBounds } from '@/lib/financeLondonDay';
import {
  ECONOMIC_DATE_STATUS,
  earningsAttributionInstant,
  isInstantInClosedRange,
  londonCivilDateKey,
  sumAttributedTripEarningNetPence,
} from '@shared/economicEarnedAtSSOT';
import {
  DEFAULT_PAYOUT_CLEARING_DELAY_HOURS,
  isPayoutClearedForPlatformCollected,
} from '@shared/driverPayoutEligibilitySSOT';
import { specResolveEconomicDate } from '@shared/economicEarnedAtResolverSpec';

const LONDON_17_AUG_START = '2026-08-16T23:00:00.000Z';
const LONDON_17_AUG_END = '2026-08-17T23:00:00.000Z';
const LONDON_18_AUG_START = '2026-08-17T23:00:00.000Z';

const MK005 = '021af8ee-f2a0-446d-9bbd-ade076f726b6';
const MK007 = '8b39acc6-91d0-43cb-b20a-49d9ef0feebd';
const MK008 = '3b48b86c-9ebf-407e-bb8b-a51ad2e75edc';
const MK009 = 'be49d383-6a8b-4cb0-9da3-2bec9d496d93';

const ledger = [
  { type: 'TRIP_EARNING_NET', amount_pence: 637, related_trip_id: MK005, created_at: '2026-08-17T11:44:02.234Z', economic_earned_at: '2026-08-17T08:42:50.690Z' },
  { type: 'TRIP_EARNING_NET', amount_pence: 425, related_trip_id: MK007, created_at: '2026-08-18T15:00:00.000Z', economic_earned_at: '2026-08-17T18:50:46.198Z' },
  { type: 'TRIP_EARNING_NET', amount_pence: 706, related_trip_id: MK009, created_at: '2026-08-18T15:00:01.000Z', economic_earned_at: '2026-08-17T19:27:16.212Z' },
  { type: 'TRIP_EARNING_NET', amount_pence: 425, related_trip_id: 'mk-260818-002', created_at: '2026-08-18T15:24:15.863Z', economic_earned_at: '2026-08-18T10:52:08.848Z' },
  { type: 'TRIP_EARNING_NET', amount_pence: 425, related_trip_id: 'mk-260818-003', created_at: '2026-08-18T15:24:16.628Z', economic_earned_at: '2026-08-18T13:35:47.011Z' },
];

describe('Admin economic earned-at lock (KPIs, widgets, invoices, DST)', () => {
  it('period KPIs attribute simulated recovery to 17 Aug; annual uses economic date', () => {
    const kpis = buildDriverWalletPeriodKpis(ledger, { now: new Date('2026-08-18T16:00:00Z') });
    expect(kpis.today_earnings_pence).toBe(850);
    expect(kpis.lifetime_earnings_pence).toBe(2618);
    expect(kpis.year_earnings_pence).toBe(2618);
    expect(kpis.timezone).toBe('Europe/London');
  });

  it('wallet summary live balance is independent of unresolved economic date', () => {
    const res = buildDriverWalletSummaryResponse({
      periodKey: 'today',
      periodFrom: LONDON_18_AUG_START,
      periodTo: '2026-08-18T22:59:59.999Z',
      account: {
        live_balance_pence: 2618,
        available_balance_pence: 0,
        pending_balance_pence: 2618,
        outstanding_debt_pence: 0,
        annual_driver_earnings_pence: 2618,
      },
      ledger: [
        ...ledger,
        { type: 'TRIP_EARNING_NET', amount_pence: 100, related_trip_id: 'unresolved', created_at: '2026-08-18T16:00:00Z', economic_earned_at: null },
      ],
    });
    expect(res.account.live_balance_pence).toBe(2618);
    expect(res.account.annual_driver_earnings_pence).toBe(2618);
    expect(res.summary.trip_credit_pence).toBe(850);
    expect(res.summary.net_wallet_movement_pence).toBe(425 + 706 + 425 + 425 + 100);
  });

  it('widgets: 17 Aug trip credits = 1,768p; net movement stays posting-dated', () => {
    const summary = buildDriverWalletPeriodSummary({
      periodFrom: LONDON_17_AUG_START,
      periodTo: '2026-08-17T22:59:59.999Z',
      ledger,
    });
    expect(summary.trip_credit_pence).toBe(1768);
    expect(summary.net_wallet_movement_pence).toBe(637);
    expect(ledger.some((r) => r.related_trip_id === MK008)).toBe(false);
  });

  it('invoices: TEN period filter uses economic_earned_at, never created_at fallback', () => {
    const periodStart = '2026-08-17T00:00:00.000Z';
    const periodEndTs = '2026-08-17T23:59:59.999Z';
    const inInvoice = ledger.filter((row) => {
      if (row.type === 'TRIP_EARNING_NET') {
        return isInstantInClosedRange(row.economic_earned_at, periodStart, periodEndTs);
      }
      return isInstantInClosedRange(row.created_at, periodStart, periodEndTs);
    });
    expect(inInvoice.reduce((s, r) => s + r.amount_pence, 0)).toBe(1768);
    expect(earningsAttributionInstant({ type: 'TRIP_EARNING_NET', created_at: '2026-08-18T15:00:00Z', economic_earned_at: null })).toBeNull();
  });

  it('K: London DST civil-day bounds', () => {
    const spring = getLondonDayBounds(new Date('2026-03-29T12:00:00.000Z'));
    const autumn = getLondonDayBounds(new Date('2026-10-25T12:00:00.000Z'));
    expect(spring.start.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(autumn.start.toISOString()).toBe('2026-10-25T00:00:00.000Z');
    expect(londonCivilDateKey('2026-03-29T12:00:00.000Z')).toBe('2026-03-29');
    expect(londonCivilDateKey('2026-10-25T12:00:00.000Z')).toBe('2026-10-25');
  });

  it('J: Pending/Available remains captured_at + 27h', () => {
    const capture = '2026-08-17T18:50:46.198Z';
    expect(isPayoutClearedForPlatformCollected({
      payment_collection_model: 'PLATFORM_COLLECTED',
      captured_at: capture,
    }, { now_ms: Date.parse('2026-08-18T16:00:00.000Z'), clearing_delay_hours: DEFAULT_PAYOUT_CLEARING_DELAY_HOURS })).toBe(false);
    expect(isPayoutClearedForPlatformCollected({
      payment_collection_model: 'PLATFORM_COLLECTED',
      captured_at: capture,
    }, { now_ms: Date.parse('2026-08-18T22:00:00.000Z'), clearing_delay_hours: DEFAULT_PAYOUT_CLEARING_DELAY_HOURS })).toBe(true);
  });

  it('C: DRIVER_COLLECTED cannot resolve TEN economic date', () => {
    const r = specResolveEconomicDate({
      type: 'TRIP_EARNING_NET',
      related_trip_id: MK007,
      created_at: '2026-08-18T15:00:00.000Z',
      financial_model: 'DRIVER_COLLECTED_COMMISSION_WALLET',
      sessions: [{
        purpose: 'RIDE_BOOKING',
        captured_at: '2026-08-17T18:50:46.198Z',
        captured_amount_pence: 480,
        status: 'CAPTURED',
        provider_state: 'CAPTURED',
        provider_state_verified_at: '2026-08-17T18:50:46.198Z',
      }],
    });
    expect(r.economic_earned_at).toBeNull();
    expect(r.economic_date_status).toBe(ECONOMIC_DATE_STATUS.FINANCIAL_MODEL_MISMATCH);
  });

  it('E: two RIDE_BOOKING rows always fail closed, even if capture fields match', () => {
    const identical = specResolveEconomicDate({
      type: 'TRIP_EARNING_NET',
      related_trip_id: MK007,
      created_at: '2026-08-18T15:00:00.000Z',
      financial_model: 'PLATFORM_COLLECTED',
      sessions: [
        {
          purpose: 'RIDE_BOOKING',
          captured_at: '2026-08-17T18:50:46.198Z',
          captured_amount_pence: 480,
          status: 'CAPTURED',
          provider_state: 'CAPTURED',
          provider_state_verified_at: '2026-08-17T18:50:46.198Z',
        },
        {
          purpose: 'RIDE_BOOKING',
          captured_at: '2026-08-17T18:50:46.198Z',
          captured_amount_pence: 480,
          status: 'CAPTURED',
          provider_state: 'CAPTURED',
          provider_state_verified_at: '2026-08-17T18:50:46.198Z',
        },
      ],
    });
    expect(identical.economic_earned_at).toBeNull();
    expect(identical.economic_date_status).toBe(ECONOMIC_DATE_STATUS.CAPTURE_AMBIGUOUS);
  });

  it('Q: dry-run 17 Aug TEN = 1,768p', () => {
    expect(sumAttributedTripEarningNetPence(ledger, LONDON_17_AUG_START, LONDON_17_AUG_END)).toBe(1768);
  });
});
