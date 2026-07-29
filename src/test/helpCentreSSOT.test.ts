import { describe, it, expect } from 'vitest';
import {
  buildHelpCentrePayload,
  isArticleVisible,
  matchesHelpSearch,
  sortArticles,
  slugifyHelpTitle,
  HELP_CENTRE_EMPTY_COPY,
  type HelpArticleRow,
  type HelpCategoryRow,
} from '../../shared/helpCentreSSOT';

const cat = (over: Partial<HelpCategoryRow> = {}): HelpCategoryRow => ({
  id: 'c1',
  audience: 'customer',
  title: 'Booking a ride',
  description: null,
  icon_key: null,
  display_order: 0,
  is_active: true,
  ...over,
});

const art = (over: Partial<HelpArticleRow> = {}): HelpArticleRow => ({
  id: 'a1',
  audience: 'customer',
  category_id: 'c1',
  title: 'How to book',
  slug: 'how-to-book',
  summary: 'Booking basics',
  body: 'Open the app and enter your destination.',
  cover_image_path: null,
  display_order: 0,
  is_featured: false,
  status: 'published',
  is_active: true,
  published_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
});

describe('Help Centre audience separation', () => {
  const customerCat = cat();
  const driverCat = cat({ id: 'c2', audience: 'driver', title: 'Going online' });
  const categories = [customerCat, driverCat];
  const customerArticle = art();
  const driverArticle = art({ id: 'a2', audience: 'driver', category_id: 'c2', title: 'Going online', slug: 'going-online' });

  it('customer query never returns driver content', () => {
    const payload = buildHelpCentrePayload('customer', categories, [customerArticle, driverArticle]);
    expect(payload.articles.map((a) => a.id)).toEqual(['a1']);
    expect(payload.categories.map((c) => c.id)).toEqual(['c1']);
  });

  it('driver query never returns customer content', () => {
    const payload = buildHelpCentrePayload('driver', categories, [customerArticle, driverArticle]);
    expect(payload.articles.map((a) => a.id)).toEqual(['a2']);
    expect(payload.categories.map((c) => c.id)).toEqual(['c2']);
  });

  it('rejects an article whose audience mismatches its category', () => {
    const mismatched = art({ id: 'a3', audience: 'driver', category_id: 'c1' });
    expect(isArticleVisible(mismatched, 'driver', categories)).toBe(false);
    expect(isArticleVisible(mismatched, 'customer', categories)).toBe(false);
  });
});

describe('Help Centre visibility rules', () => {
  const categories = [cat()];

  it('hides draft articles', () => {
    expect(isArticleVisible(art({ status: 'draft' }), 'customer', categories)).toBe(false);
  });

  it('hides inactive articles', () => {
    expect(isArticleVisible(art({ is_active: false }), 'customer', categories)).toBe(false);
  });

  it('hides articles in an inactive category', () => {
    expect(isArticleVisible(art(), 'customer', [cat({ is_active: false })])).toBe(false);
  });

  it('hides articles whose publish date has not been reached', () => {
    const future = art({ published_at: '2030-01-01T00:00:00Z' });
    expect(isArticleVisible(future, 'customer', categories, new Date('2026-01-02T00:00:00Z'))).toBe(false);
  });

  it('shows published, active, in-date articles', () => {
    expect(isArticleVisible(art(), 'customer', categories, new Date('2026-02-01T00:00:00Z'))).toBe(true);
  });
});

describe('Help Centre search, ordering and empty state', () => {
  it('searches title, summary and body', () => {
    expect(matchesHelpSearch(art(), 'destination')).toBe(true);
    expect(matchesHelpSearch(art(), 'BOOKING')).toBe(true);
    expect(matchesHelpSearch(art(), 'payout')).toBe(false);
    expect(matchesHelpSearch(art(), '   ')).toBe(true);
  });

  it('orders featured first, then display order, then title', () => {
    const rows = [
      art({ id: 'b', title: 'B', display_order: 2 }),
      art({ id: 'f', title: 'F', is_featured: true, display_order: 9 }),
      art({ id: 'a', title: 'A', display_order: 1 }),
    ];
    expect(sortArticles(rows).map((r) => r.id)).toEqual(['f', 'a', 'b']);
  });

  it('returns the canonical empty state when nothing is published', () => {
    const payload = buildHelpCentrePayload('customer', [cat()], [art({ status: 'draft' })]);
    expect(payload.empty).toBe(true);
    expect(payload.empty_copy).toBe(HELP_CENTRE_EMPTY_COPY);
    expect(payload.articles).toHaveLength(0);
  });

  it('slugifies titles safely', () => {
    expect(slugifyHelpTitle('  Waiting-time charges & fees! ')).toBe('waiting-time-charges-fees');
  });
});
