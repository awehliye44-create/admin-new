/**
 * Campaign / Celebration Heads-Up — reusable admin template catalog (System B).
 * Completely separate from the 12 operational customer heads-up events (System A).
 */

export type CampaignHeadsUpCategory =
  | 'sports'
  | 'religious'
  | 'celebration'
  | 'promotion'
  | 'announcement';

export type CampaignTargetApp = 'customer' | 'driver' | 'both';

export type CampaignTargetScope = 'global' | 'region' | 'service_area' | 'users';

export type CampaignScheduleMode =
  | 'instant'
  | 'scheduled'
  | 'repeat_yearly'
  | 'repeat_monthly';

export type CampaignAccentColor =
  | 'blue'
  | 'pink'
  | 'purple'
  | 'green'
  | 'yellow'
  | 'orange'
  | 'red';

export interface CampaignHeadsUpTemplateSeed {
  slug: string;
  category: CampaignHeadsUpCategory;
  name: string;
  title: string;
  subtitle: string;
  emoji: string;
  accent_color: CampaignAccentColor;
  gradient_from: string;
  gradient_to: string;
  cta_label?: string;
  cta_url?: string;
  deep_link?: string;
  default_target_app: CampaignTargetApp;
}

export const CAMPAIGN_HEADS_UP_CATEGORIES: Record<
  CampaignHeadsUpCategory,
  { label: string; description: string }
> = {
  sports: { label: 'Sports', description: 'Major sporting events and finals' },
  religious: { label: 'Religious', description: 'Faith and cultural celebrations' },
  celebration: { label: 'Celebration', description: 'Holidays and milestones' },
  promotion: { label: 'Promotion', description: 'Discounts and referral campaigns' },
  announcement: { label: 'Announcement', description: 'Product and service updates' },
};

/** Pre-built reusable Mojo-style templates — admin can edit any field after selection. */
export const CAMPAIGN_HEADS_UP_TEMPLATE_SEEDS: CampaignHeadsUpTemplateSeed[] = [
  // Sports
  { slug: 'champions_league_final', category: 'sports', name: 'Champions League Final', title: 'UEFA Champions League Final! ⚽🏆', subtitle: "The ultimate showdown is here! Don't miss the UCL Final this weekend.", emoji: '⚽', accent_color: 'blue', gradient_from: '#1e3a8a', gradient_to: '#3b82f6', cta_label: 'See Details', cta_url: '/promotions/champions-league', default_target_app: 'customer' },
  { slug: 'europa_league_final', category: 'sports', name: 'Europa League Final', title: 'Europa League Final ⚽', subtitle: 'Catch every moment of the Europa League Final.', emoji: '⚽', accent_color: 'orange', gradient_from: '#c2410c', gradient_to: '#fb923c', default_target_app: 'customer' },
  { slug: 'conference_league_final', category: 'sports', name: 'Conference League Final', title: 'Conference League Final ⚽', subtitle: 'The Conference League Final is here!', emoji: '⚽', accent_color: 'green', gradient_from: '#166534', gradient_to: '#4ade80', default_target_app: 'customer' },
  { slug: 'uefa_euro', category: 'sports', name: 'UEFA Euro', title: 'UEFA Euro 🏆', subtitle: 'Europe\'s finest compete — enjoy the tournament with ONECAB.', emoji: '🏆', accent_color: 'blue', gradient_from: '#1e40af', gradient_to: '#60a5fa', default_target_app: 'customer' },
  { slug: 'fifa_world_cup', category: 'sports', name: 'FIFA World Cup', title: 'FIFA World Cup 2026 🌍⚽', subtitle: 'The world\'s biggest tournament — ride with ONECAB.', emoji: '🌍', accent_color: 'red', gradient_from: '#991b1b', gradient_to: '#f87171', cta_label: 'Explore', cta_url: '/promotions/world-cup', default_target_app: 'both' },
  { slug: 'afcon', category: 'sports', name: 'AFCON', title: 'AFCON 🦁⚽', subtitle: 'Africa\'s top teams battle it out — celebrate with ONECAB.', emoji: '🦁', accent_color: 'green', gradient_from: '#14532d', gradient_to: '#22c55e', default_target_app: 'both' },
  { slug: 'premier_league_final_day', category: 'sports', name: 'Premier League Final Day', title: 'Premier League Final Day ⚽', subtitle: 'Title deciders and drama — plan your rides ahead.', emoji: '⚽', accent_color: 'purple', gradient_from: '#581c87', gradient_to: '#a855f7', default_target_app: 'customer' },
  { slug: 'fa_cup_final', category: 'sports', name: 'FA Cup Final', title: 'FA Cup Final 🏆', subtitle: 'Wembley awaits — get there with ONECAB.', emoji: '🏆', accent_color: 'red', gradient_from: '#7f1d1d', gradient_to: '#ef4444', default_target_app: 'customer' },
  { slug: 'carabao_cup_final', category: 'sports', name: 'Carabao Cup Final', title: 'Carabao Cup Final ⚽', subtitle: 'League Cup glory — ride to the match.', emoji: '⚽', accent_color: 'green', gradient_from: '#065f46', gradient_to: '#34d399', default_target_app: 'customer' },
  { slug: 'copa_america', category: 'sports', name: 'Copa America', title: 'Copa America 🏆', subtitle: 'South America\'s finest — celebrate every goal.', emoji: '🏆', accent_color: 'blue', gradient_from: '#1d4ed8', gradient_to: '#93c5fd', default_target_app: 'both' },
  { slug: 'olympic_games', category: 'sports', name: 'Olympic Games', title: 'Olympic Games 🥇', subtitle: 'The world unites — ride to every event.', emoji: '🥇', accent_color: 'yellow', gradient_from: '#a16207', gradient_to: '#fde047', default_target_app: 'both' },
  // Religious
  { slug: 'ramadan_mubarak', category: 'religious', name: 'Ramadan Mubarak', title: 'Ramadan Mubarak 🌙', subtitle: 'Wishing you a blessed and peaceful Ramadan.', emoji: '🌙', accent_color: 'purple', gradient_from: '#4c1d95', gradient_to: '#c4b5fd', default_target_app: 'both' },
  { slug: 'eid_mubarak', category: 'religious', name: 'Eid Mubarak', title: 'Eid Mubarak 🕌✨', subtitle: 'Wishing you joy, peace, and blessings this Eid.', emoji: '🕌', accent_color: 'green', gradient_from: '#166534', gradient_to: '#86efac', default_target_app: 'both' },
  { slug: 'eid_al_adha', category: 'religious', name: 'Eid Al Adha', title: 'Eid Al Adha 🕌', subtitle: 'Warm wishes on this blessed occasion.', emoji: '🕌', accent_color: 'green', gradient_from: '#14532d', gradient_to: '#4ade80', default_target_app: 'both' },
  { slug: 'christmas', category: 'religious', name: 'Christmas', title: 'Merry Christmas 🎄', subtitle: 'Warm wishes for a joyful Christmas season.', emoji: '🎄', accent_color: 'red', gradient_from: '#991b1b', gradient_to: '#fca5a5', default_target_app: 'both' },
  { slug: 'easter', category: 'religious', name: 'Easter', title: 'Happy Easter 🐣', subtitle: 'Wishing you peace and joy this Easter.', emoji: '🐣', accent_color: 'yellow', gradient_from: '#ca8a04', gradient_to: '#fef08a', default_target_app: 'both' },
  { slug: 'diwali', category: 'religious', name: 'Diwali', title: 'Happy Diwali 🪔', subtitle: 'May the festival of lights bring prosperity.', emoji: '🪔', accent_color: 'orange', gradient_from: '#c2410c', gradient_to: '#fdba74', default_target_app: 'both' },
  { slug: 'lunar_new_year', category: 'religious', name: 'Lunar New Year', title: 'Happy Lunar New Year 🧧', subtitle: 'Gong Xi Fa Cai — prosperity and good fortune!', emoji: '🧧', accent_color: 'red', gradient_from: '#b91c1c', gradient_to: '#fecaca', default_target_app: 'both' },
  // Celebration
  { slug: 'happy_new_year', category: 'celebration', name: 'Happy New Year', title: 'Happy New Year 🎆', subtitle: 'Cheers to new beginnings with ONECAB!', emoji: '🎆', accent_color: 'purple', gradient_from: '#581c87', gradient_to: '#d8b4fe', default_target_app: 'both' },
  { slug: 'welcome_onecab', category: 'celebration', name: 'Welcome to ONECAB', title: 'Welcome to ONECAB 🚖', subtitle: 'Your premium ride experience starts here.', emoji: '🚖', accent_color: 'blue', gradient_from: '#1e3a8a', gradient_to: '#60a5fa', default_target_app: 'both' },
  { slug: 'anniversary', category: 'celebration', name: 'Anniversary', title: 'ONECAB Anniversary 🎉', subtitle: 'Celebrating another year of rides together.', emoji: '🎉', accent_color: 'pink', gradient_from: '#9d174d', gradient_to: '#f9a8d4', default_target_app: 'both' },
  { slug: 'regional_launch', category: 'celebration', name: 'Regional Launch', title: 'ONECAB is here! 🚀', subtitle: 'Premium rides now available in your city.', emoji: '🚀', accent_color: 'green', gradient_from: '#166534', gradient_to: '#6ee7b7', default_target_app: 'both' },
  // Promotion
  { slug: 'airport_discount', category: 'promotion', name: 'Airport Discount', title: 'Airport rides — save today ✈️', subtitle: 'Special airport transfer discount for a limited time.', emoji: '✈️', accent_color: 'blue', gradient_from: '#1e40af', gradient_to: '#93c5fd', cta_label: 'Book Now', cta_url: '/book-ride', default_target_app: 'customer' },
  { slug: 'weekend_sale', category: 'promotion', name: 'Weekend Sale', title: 'Weekend Sale 🎉', subtitle: 'Save on rides this weekend only.', emoji: '🎉', accent_color: 'pink', gradient_from: '#be185d', gradient_to: '#fbcfe8', cta_label: 'Ride Now', cta_url: '/book-ride', default_target_app: 'customer' },
  { slug: 'invite_friends', category: 'promotion', name: 'Invite Friends', title: 'Invite friends, earn rewards 🎁', subtitle: 'Share ONECAB and both of you save.', emoji: '🎁', accent_color: 'purple', gradient_from: '#6b21a8', gradient_to: '#d8b4fe', cta_label: 'Invite', cta_url: '/referrals', default_target_app: 'customer' },
  { slug: 'promo_code', category: 'promotion', name: 'Promo Code', title: 'Use code SAVE20 🏷️', subtitle: '20% off your next ride — limited time.', emoji: '🏷️', accent_color: 'orange', gradient_from: '#c2410c', gradient_to: '#fdba74', cta_label: 'Apply Code', cta_url: '/book-ride', default_target_app: 'customer' },
  { slug: 'cashback', category: 'promotion', name: 'Cashback', title: 'Earn cashback 💰', subtitle: 'Get money back on eligible rides.', emoji: '💰', accent_color: 'green', gradient_from: '#15803d', gradient_to: '#86efac', default_target_app: 'customer' },
  { slug: 'ride_and_save', category: 'promotion', name: 'Ride & Save', title: 'Ride & Save 🚗', subtitle: 'The more you ride, the more you save.', emoji: '🚗', accent_color: 'blue', gradient_from: '#1d4ed8', gradient_to: '#bfdbfe', default_target_app: 'customer' },
  // Announcement
  { slug: 'app_update', category: 'announcement', name: 'App Update', title: 'App update available 📱', subtitle: 'Update ONECAB for the latest features and fixes.', emoji: '📱', accent_color: 'blue', gradient_from: '#1e3a8a', gradient_to: '#93c5fd', default_target_app: 'both' },
  { slug: 'new_feature', category: 'announcement', name: 'New Feature', title: 'New feature unlocked ✨', subtitle: 'Discover what\'s new in ONECAB.', emoji: '✨', accent_color: 'purple', gradient_from: '#581c87', gradient_to: '#e9d5ff', default_target_app: 'both' },
  { slug: 'payment_method', category: 'announcement', name: 'Payment Method', title: 'New payment method 💳', subtitle: 'Pay your way — a new option is now available.', emoji: '💳', accent_color: 'green', gradient_from: '#166534', gradient_to: '#bbf7d0', default_target_app: 'both' },
  { slug: 'service_maintenance', category: 'announcement', name: 'Service Maintenance', title: 'Scheduled maintenance 🔧', subtitle: 'Brief service window — rides may be limited.', emoji: '🔧', accent_color: 'yellow', gradient_from: '#a16207', gradient_to: '#fef08a', default_target_app: 'both' },
];

export const CAMPAIGN_HEADS_UP_AUTO_DISMISS_MS = 4_000;

export const CAMPAIGN_PUSH_LAYER = 'campaign' as const;
