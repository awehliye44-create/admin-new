/**
 * Help Centre SSOT — pure audience/visibility rules.
 * Used by the Admin panel, the read Edge Function and tests.
 * Audience separation is enforced here AND in SQL (RLS + trigger).
 */

export type HelpAudience = 'customer' | 'driver';

export interface HelpCategoryRow {
  id: string;
  audience: HelpAudience;
  title: string;
  description: string | null;
  icon_key: string | null;
  display_order: number;
  is_active: boolean;
}

export interface HelpArticleRow {
  id: string;
  audience: HelpAudience;
  category_id: string;
  title: string;
  slug: string;
  summary: string | null;
  body: string;
  cover_image_path: string | null;
  display_order: number;
  is_featured: boolean;
  status: 'draft' | 'published';
  is_active: boolean;
  published_at: string | null;
  updated_at: string;
}

export const HELP_AUDIENCES: HelpAudience[] = ['customer', 'driver'];

export function isHelpAudience(value: unknown): value is HelpAudience {
  return value === 'customer' || value === 'driver';
}

export const HELP_CENTRE_EMPTY_COPY = 'No help articles are available right now.';

/** Category is publicly visible to a mobile app. */
export function isCategoryVisible(cat: HelpCategoryRow, audience: HelpAudience): boolean {
  return cat.is_active && cat.audience === audience;
}

/**
 * Article is visible to a mobile app for the requested audience.
 * Requires: matching audience, active, published, publish date reached, active matching category.
 */
export function isArticleVisible(
  article: HelpArticleRow,
  audience: HelpAudience,
  categories: HelpCategoryRow[],
  now: Date = new Date(),
): boolean {
  if (article.audience !== audience) return false;
  if (!article.is_active) return false;
  if (article.status !== 'published') return false;
  if (article.published_at && new Date(article.published_at).getTime() > now.getTime()) return false;
  const cat = categories.find((c) => c.id === article.category_id);
  if (!cat) return false;
  if (cat.audience !== audience) return false;
  return cat.is_active;
}

/** Ordering SSOT: featured first, then display_order, then title. */
export function sortArticles<T extends Pick<HelpArticleRow, 'is_featured' | 'display_order' | 'title'>>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.is_featured !== b.is_featured) return a.is_featured ? -1 : 1;
    if (a.display_order !== b.display_order) return a.display_order - b.display_order;
    return a.title.localeCompare(b.title);
  });
}

export function sortCategories<T extends Pick<HelpCategoryRow, 'display_order' | 'title'>>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    a.display_order !== b.display_order ? a.display_order - b.display_order : a.title.localeCompare(b.title),
  );
}

/** Case-insensitive search across title / summary / body text. */
export function matchesHelpSearch(article: Pick<HelpArticleRow, 'title' | 'summary' | 'body'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [article.title, article.summary ?? '', article.body]
    .join(' ')
    .toLowerCase()
    .includes(q);
}

/** Full mobile projection for one audience. Never leaks the other audience. */
export function buildHelpCentrePayload(
  audience: HelpAudience,
  categories: HelpCategoryRow[],
  articles: HelpArticleRow[],
  now: Date = new Date(),
) {
  const visibleCategories = sortCategories(categories.filter((c) => isCategoryVisible(c, audience)));
  const visibleArticles = sortArticles(articles.filter((a) => isArticleVisible(a, audience, categories, now)));
  return {
    audience,
    categories: visibleCategories,
    articles: visibleArticles,
    featured: visibleArticles.filter((a) => a.is_featured),
    empty: visibleArticles.length === 0,
    empty_copy: HELP_CENTRE_EMPTY_COPY,
  };
}

/** Slugify a title for the audience-unique slug. */
export function slugifyHelpTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
