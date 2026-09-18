import {
  resolveSavedCardChargeInitiator,
  mustPresentAcsWhenRevolutRequires,
} from '../../functions/_shared/revolutSavedCardMitMandate.draft.ts';

Deno.test('customer-saved method stays CIT and must not skip SCA', () => {
  const decided = resolveSavedCardChargeInitiator({
    methodSavedFor: 'customer',
    merchantMandateApproved: true,
  });
  if (decided.initiator !== 'customer' || decided.maySkip3ds) {
    throw new Error(`expected customer CIT, got ${JSON.stringify(decided)}`);
  }
});

Deno.test('Book customerPresent + merchant-vault stays CIT (saved_for cannot flip)', () => {
  const decided = resolveSavedCardChargeInitiator({
    methodSavedFor: 'merchant',
    merchantMandateApproved: true,
    customerPresent: true,
  });
  if (decided.initiator !== 'customer' || decided.maySkip3ds) {
    throw new Error(`Book must stay CIT even for merchant-vault, got ${JSON.stringify(decided)}`);
  }
});

Deno.test('genuine off-session merchant mandate is draft MIT only (unwired from Book)', () => {
  const decided = resolveSavedCardChargeInitiator({
    methodSavedFor: 'merchant',
    merchantMandateApproved: true,
    customerPresent: false,
  });
  if (decided.initiator !== 'merchant' || !decided.maySkip3ds) {
    throw new Error(`expected merchant MIT for off-session draft, got ${JSON.stringify(decided)}`);
  }
  if (!mustPresentAcsWhenRevolutRequires('https://acs.example/challenge')) {
    throw new Error('ACS URL must still be presented');
  }
  if (mustPresentAcsWhenRevolutRequires('')) {
    throw new Error('empty ACS must not force a challenge');
  }
});
