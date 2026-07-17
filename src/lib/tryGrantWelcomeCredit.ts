/**
 * Soft-fail welcome credit after driver approval (Phase 5).
 * Never blocks approval — toast/log only on unexpected failures.
 */
import { supabase } from '@/integrations/supabase/client';
import {
  ADMIN_COMMISSION_CREDIT_KIND,
  COMMISSION_WALLET_CAMPAIGN_TYPE,
  buildCommissionWalletWelcomeIdempotencyKey,
  isCommissionWalletWorkflowEnabled,
} from '../../shared/commissionWalletSSOT';

export type WelcomeGrantAttempt = {
  service_area_id: string;
  ok: boolean;
  skipped?: boolean;
  code?: string;
  error?: string;
};

function softSkipCode(code: string | undefined): boolean {
  const c = String(code ?? '').toUpperCase();
  return (
    c === 'WALLET_DISABLED'
    || c === 'WELCOME_CREDIT_DISABLED'
    || c === 'WELCOME_CREDIT_ALREADY_RECEIVED'
    || c === 'WELCOME_CREDIT_MAX_DRIVERS'
    || c === 'WELCOME_CREDIT_MAX_DRIVERS_REACHED'
    || c === 'WELCOME_CREDIT_AMOUNT_MISMATCH'
    || c === 'DRIVER_NOT_IN_SERVICE_AREA'
    || c === 'CURRENCY_REQUIRED'
    || c === 'SA_NOT_FOUND'
  );
}

/** Exported for unit tests — soft-fail codes must not toast as hard failures. */
export function isWelcomeGrantSoftSkipCode(code: string | undefined): boolean {
  return softSkipCode(code);
}

export async function tryGrantWelcomeCredit(driverId: string): Promise<WelcomeGrantAttempt[]> {
  const id = String(driverId ?? '').trim();
  if (!id) return [];

  const attempts: WelcomeGrantAttempt[] = [];

  const { data: driver } = await supabase
    .from('drivers')
    .select('id, service_area_id')
    .eq('id', id)
    .maybeSingle();

  const { data: assignments } = await supabase
    .from('driver_service_areas')
    .select('service_area_id')
    .eq('driver_id', id);

  const saIds = new Set<string>();
  for (const row of assignments ?? []) {
    if (row.service_area_id) saIds.add(String(row.service_area_id));
  }
  if (driver?.service_area_id) saIds.add(String(driver.service_area_id));

  for (const serviceAreaId of saIds) {
    const { data: sa } = await supabase
      .from('service_areas')
      .select(
        'id, financial_model, commission_wallet_enabled, commission_wallet_currency, currency_code, welcome_credit_enabled, welcome_credit_amount_minor',
      )
      .eq('id', serviceAreaId)
      .maybeSingle();

    if (!sa) {
      attempts.push({ service_area_id: serviceAreaId, ok: false, skipped: true, code: 'SA_NOT_FOUND' });
      continue;
    }

    const walletEnabled = isCommissionWalletWorkflowEnabled({
      financial_model: sa.financial_model,
      commission_wallet_enabled: sa.commission_wallet_enabled,
    });
    if (!walletEnabled || !sa.welcome_credit_enabled) {
      attempts.push({
        service_area_id: serviceAreaId,
        ok: false,
        skipped: true,
        code: walletEnabled ? 'WELCOME_CREDIT_DISABLED' : 'WALLET_DISABLED',
      });
      continue;
    }

    const amountMinor = Math.round(Number(sa.welcome_credit_amount_minor) || 0);
    if (amountMinor <= 0) {
      attempts.push({
        service_area_id: serviceAreaId,
        ok: false,
        skipped: true,
        code: 'WELCOME_CREDIT_AMOUNT_MISMATCH',
      });
      continue;
    }

    const currency = String(
      sa.commission_wallet_currency || sa.currency_code || '',
    ).toUpperCase();
    if (!currency) {
      attempts.push({
        service_area_id: serviceAreaId,
        ok: false,
        skipped: true,
        code: 'CURRENCY_REQUIRED',
      });
      continue;
    }

    const { data: welcomeCampaigns } = await supabase
      .from('commission_wallet_campaigns')
      .select('id, active, start_at, end_at')
      .eq('service_area_id', serviceAreaId)
      .eq('campaign_type', COMMISSION_WALLET_CAMPAIGN_TYPE.WELCOME_CREDIT)
      .eq('active', true)
      .limit(5);

    const now = Date.now();
    const campaign = (welcomeCampaigns ?? []).find((c) => {
      if (c.start_at && Date.parse(String(c.start_at)) > now) return false;
      if (c.end_at && Date.parse(String(c.end_at)) < now) return false;
      return true;
    });

    const { data, error } = await supabase.functions.invoke('admin-commission-wallet-credit', {
      body: {
        driver_id: id,
        service_area_id: serviceAreaId,
        amount_minor: amountMinor,
        currency,
        credit_kind: ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT,
        reason: 'Auto welcome credit (Phase 5)',
        campaign_id: campaign?.id ?? null,
        idempotency_key: buildCommissionWalletWelcomeIdempotencyKey(id, serviceAreaId),
      },
    });

    if (error) {
      console.warn('[tryGrantWelcomeCredit]', serviceAreaId, error.message);
      attempts.push({
        service_area_id: serviceAreaId,
        ok: false,
        error: error.message,
      });
      continue;
    }

    if (!data?.success) {
      const code = String(data?.code ?? '');
      const skipped = softSkipCode(code);
      if (!skipped) {
        console.warn('[tryGrantWelcomeCredit]', serviceAreaId, data?.error, code);
      }
      attempts.push({
        service_area_id: serviceAreaId,
        ok: false,
        skipped,
        code,
        error: data?.error ? String(data.error) : undefined,
      });
      continue;
    }

    attempts.push({ service_area_id: serviceAreaId, ok: true });
  }

  return attempts;
}
