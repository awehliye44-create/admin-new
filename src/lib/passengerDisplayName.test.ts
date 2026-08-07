import {
  formatCustomerNameParts,
  isPlaceholderPassengerName,
  resolvePassengerDisplayName,
} from '@/lib/passengerDisplayName';

describe('passengerDisplayName', () => {
  it('treats Guest / empty / Unknown as placeholders', () => {
    expect(isPlaceholderPassengerName('Guest')).toBe(true);
    expect(isPlaceholderPassengerName('unknown')).toBe(true);
    expect(isPlaceholderPassengerName('')).toBe(true);
    expect(isPlaceholderPassengerName('Ahmed Osman')).toBe(false);
  });

  it('prefers real stored name over customer profile', () => {
    expect(
      resolvePassengerDisplayName({
        passenger_name: 'Other Rider',
        customer: { first_name: 'Ahmed', last_name: 'Osman' },
      }),
    ).toBe('Other Rider');
  });

  it('falls back to customers profile when stored name is Guest', () => {
    expect(
      resolvePassengerDisplayName({
        passenger_name: 'Guest',
        customer: { first_name: 'Ahmed', last_name: 'Osman' },
      }),
    ).toBe('Ahmed Osman');
    expect(formatCustomerNameParts({ first_name: 'Ahmed', last_name: null })).toBe('Ahmed');
  });

  it('returns Unknown when nothing usable exists', () => {
    expect(resolvePassengerDisplayName({ passenger_name: null, customer: null })).toBe('Unknown');
  });
});
