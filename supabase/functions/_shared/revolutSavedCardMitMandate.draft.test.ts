import { resolveSavedCardChargeInitiator, mustPresentAcsWhenRevolutRequires } from './revolutSavedCardMitMandate.draft.ts';

Deno.test('customer-saved method stays CIT and must not skip SCA', () => {
  const decided = resolveSavedCardChargeInitiator({
    methodSavedFor: 'customer',
    merchantMandateApproved: true,
  });
  if (decided.initiator !== 'customer' || decided.maySkip3ds) {
    throw new Error(`expected customer CIT, got ${JSON.stringify(decided)}`);
  }
});

Deno.test('merchant mandate is the only MIT skip path', () => {
  const decided = resolveSavedCardChargeInitiator({
    methodSavedFor: 'merchant',
    merchantMandateApproved: true,
  });
  if (decided.initiator !== 'merchant' || !decided.maySkip3ds) {
    throw new Error(`expected merchant MIT, got ${JSON.stringify(decided)}`);
  }
  if (!mustPresentAcsWhenRevolutRequires('https://acs.example/challenge')) {
    throw new Error('ACS URL must still be presented');
  }
  if (mustPresentAcsWhenRevolutRequires('')) {
    throw new Error('empty ACS must not force a challenge');
  }
});
