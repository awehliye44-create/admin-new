/** Country code list — extracted to avoid re-parsing on every Auth render */
export interface CountryCode {
  code: string;
  flag: string;
  label: string;
  name: string;
}

export const COUNTRY_CODES: readonly CountryCode[] = [
  { code: "+44", flag: "🇬🇧", label: "GB", name: "United Kingdom" },
  { code: "+1", flag: "🇺🇸", label: "US", name: "United States" },
  { code: "+93", flag: "🇦🇫", label: "AF", name: "Afghanistan" },
  { code: "+355", flag: "🇦🇱", label: "AL", name: "Albania" },
  { code: "+213", flag: "🇩🇿", label: "DZ", name: "Algeria" },
  { code: "+376", flag: "🇦🇩", label: "AD", name: "Andorra" },
  { code: "+244", flag: "🇦🇴", label: "AO", name: "Angola" },
  { code: "+1268", flag: "🇦🇬", label: "AG", name: "Antigua & Barbuda" },
  { code: "+54", flag: "🇦🇷", label: "AR", name: "Argentina" },
  { code: "+374", flag: "🇦🇲", label: "AM", name: "Armenia" },
  { code: "+61", flag: "🇦🇺", label: "AU", name: "Australia" },
  { code: "+43", flag: "🇦🇹", label: "AT", name: "Austria" },
  { code: "+994", flag: "🇦🇿", label: "AZ", name: "Azerbaijan" },
  { code: "+1242", flag: "🇧🇸", label: "BS", name: "Bahamas" },
  { code: "+973", flag: "🇧🇭", label: "BH", name: "Bahrain" },
  { code: "+880", flag: "🇧🇩", label: "BD", name: "Bangladesh" },
  { code: "+1246", flag: "🇧🇧", label: "BB", name: "Barbados" },
  { code: "+375", flag: "🇧🇾", label: "BY", name: "Belarus" },
  { code: "+32", flag: "🇧🇪", label: "BE", name: "Belgium" },
  { code: "+501", flag: "🇧🇿", label: "BZ", name: "Belize" },
  { code: "+229", flag: "🇧🇯", label: "BJ", name: "Benin" },
  { code: "+975", flag: "🇧🇹", label: "BT", name: "Bhutan" },
  { code: "+591", flag: "🇧🇴", label: "BO", name: "Bolivia" },
  { code: "+387", flag: "🇧🇦", label: "BA", name: "Bosnia & Herzegovina" },
  { code: "+267", flag: "🇧🇼", label: "BW", name: "Botswana" },
  { code: "+55", flag: "🇧🇷", label: "BR", name: "Brazil" },
  { code: "+673", flag: "🇧🇳", label: "BN", name: "Brunei" },
  { code: "+359", flag: "🇧🇬", label: "BG", name: "Bulgaria" },
  { code: "+226", flag: "🇧🇫", label: "BF", name: "Burkina Faso" },
  { code: "+257", flag: "🇧🇮", label: "BI", name: "Burundi" },
  { code: "+855", flag: "🇰🇭", label: "KH", name: "Cambodia" },
  { code: "+237", flag: "🇨🇲", label: "CM", name: "Cameroon" },
  { code: "+1", flag: "🇨🇦", label: "CA", name: "Canada" },
  { code: "+238", flag: "🇨🇻", label: "CV", name: "Cape Verde" },
  { code: "+236", flag: "🇨🇫", label: "CF", name: "Central African Republic" },
  { code: "+235", flag: "🇹🇩", label: "TD", name: "Chad" },
  { code: "+56", flag: "🇨🇱", label: "CL", name: "Chile" },
  { code: "+86", flag: "🇨🇳", label: "CN", name: "China" },
  { code: "+57", flag: "🇨🇴", label: "CO", name: "Colombia" },
  { code: "+269", flag: "🇰🇲", label: "KM", name: "Comoros" },
  { code: "+242", flag: "🇨🇬", label: "CG", name: "Congo" },
  { code: "+243", flag: "🇨🇩", label: "CD", name: "DR Congo" },
  { code: "+506", flag: "🇨🇷", label: "CR", name: "Costa Rica" },
  { code: "+225", flag: "🇨🇮", label: "CI", name: "Côte d'Ivoire" },
  { code: "+385", flag: "🇭🇷", label: "HR", name: "Croatia" },
  { code: "+53", flag: "🇨🇺", label: "CU", name: "Cuba" },
  { code: "+357", flag: "🇨🇾", label: "CY", name: "Cyprus" },
  { code: "+420", flag: "🇨🇿", label: "CZ", name: "Czech Republic" },
  { code: "+45", flag: "🇩🇰", label: "DK", name: "Denmark" },
  { code: "+253", flag: "🇩🇯", label: "DJ", name: "Djibouti" },
  { code: "+1767", flag: "🇩🇲", label: "DM", name: "Dominica" },
  { code: "+1809", flag: "🇩🇴", label: "DO", name: "Dominican Republic" },
  { code: "+593", flag: "🇪🇨", label: "EC", name: "Ecuador" },
  { code: "+20", flag: "🇪🇬", label: "EG", name: "Egypt" },
  { code: "+503", flag: "🇸🇻", label: "SV", name: "El Salvador" },
  { code: "+240", flag: "🇬🇶", label: "GQ", name: "Equatorial Guinea" },
  { code: "+291", flag: "🇪🇷", label: "ER", name: "Eritrea" },
  { code: "+372", flag: "🇪🇪", label: "EE", name: "Estonia" },
  { code: "+268", flag: "🇸🇿", label: "SZ", name: "Eswatini" },
  { code: "+251", flag: "🇪🇹", label: "ET", name: "Ethiopia" },
  { code: "+679", flag: "🇫🇯", label: "FJ", name: "Fiji" },
  { code: "+358", flag: "🇫🇮", label: "FI", name: "Finland" },
  { code: "+33", flag: "🇫🇷", label: "FR", name: "France" },
  { code: "+241", flag: "🇬🇦", label: "GA", name: "Gabon" },
  { code: "+220", flag: "🇬🇲", label: "GM", name: "Gambia" },
  { code: "+995", flag: "🇬🇪", label: "GE", name: "Georgia" },
  { code: "+49", flag: "🇩🇪", label: "DE", name: "Germany" },
  { code: "+233", flag: "🇬🇭", label: "GH", name: "Ghana" },
  { code: "+30", flag: "🇬🇷", label: "GR", name: "Greece" },
  { code: "+1473", flag: "🇬🇩", label: "GD", name: "Grenada" },
  { code: "+502", flag: "🇬🇹", label: "GT", name: "Guatemala" },
  { code: "+224", flag: "🇬🇳", label: "GN", name: "Guinea" },
  { code: "+245", flag: "🇬🇼", label: "GW", name: "Guinea-Bissau" },
  { code: "+592", flag: "🇬🇾", label: "GY", name: "Guyana" },
  { code: "+509", flag: "🇭🇹", label: "HT", name: "Haiti" },
  { code: "+504", flag: "🇭🇳", label: "HN", name: "Honduras" },
  { code: "+852", flag: "🇭🇰", label: "HK", name: "Hong Kong" },
  { code: "+36", flag: "🇭🇺", label: "HU", name: "Hungary" },
  { code: "+354", flag: "🇮🇸", label: "IS", name: "Iceland" },
  { code: "+91", flag: "🇮🇳", label: "IN", name: "India" },
  { code: "+62", flag: "🇮🇩", label: "ID", name: "Indonesia" },
  { code: "+98", flag: "🇮🇷", label: "IR", name: "Iran" },
  { code: "+964", flag: "🇮🇶", label: "IQ", name: "Iraq" },
  { code: "+353", flag: "🇮🇪", label: "IE", name: "Ireland" },
  { code: "+972", flag: "🇮🇱", label: "IL", name: "Israel" },
  { code: "+39", flag: "🇮🇹", label: "IT", name: "Italy" },
  { code: "+1876", flag: "🇯🇲", label: "JM", name: "Jamaica" },
  { code: "+81", flag: "🇯🇵", label: "JP", name: "Japan" },
  { code: "+962", flag: "🇯🇴", label: "JO", name: "Jordan" },
  { code: "+7", flag: "🇰🇿", label: "KZ", name: "Kazakhstan" },
  { code: "+254", flag: "🇰🇪", label: "KE", name: "Kenya" },
  { code: "+686", flag: "🇰🇮", label: "KI", name: "Kiribati" },
  { code: "+965", flag: "🇰🇼", label: "KW", name: "Kuwait" },
  { code: "+996", flag: "🇰🇬", label: "KG", name: "Kyrgyzstan" },
  { code: "+856", flag: "🇱🇦", label: "LA", name: "Laos" },
  { code: "+371", flag: "🇱🇻", label: "LV", name: "Latvia" },
  { code: "+961", flag: "🇱🇧", label: "LB", name: "Lebanon" },
  { code: "+266", flag: "🇱🇸", label: "LS", name: "Lesotho" },
  { code: "+231", flag: "🇱🇷", label: "LR", name: "Liberia" },
  { code: "+218", flag: "🇱🇾", label: "LY", name: "Libya" },
  { code: "+423", flag: "🇱🇮", label: "LI", name: "Liechtenstein" },
  { code: "+370", flag: "🇱🇹", label: "LT", name: "Lithuania" },
  { code: "+352", flag: "🇱🇺", label: "LU", name: "Luxembourg" },
  { code: "+853", flag: "🇲🇴", label: "MO", name: "Macau" },
  { code: "+261", flag: "🇲🇬", label: "MG", name: "Madagascar" },
  { code: "+265", flag: "🇲🇼", label: "MW", name: "Malawi" },
  { code: "+60", flag: "🇲🇾", label: "MY", name: "Malaysia" },
  { code: "+960", flag: "🇲🇻", label: "MV", name: "Maldives" },
  { code: "+223", flag: "🇲🇱", label: "ML", name: "Mali" },
  { code: "+356", flag: "🇲🇹", label: "MT", name: "Malta" },
  { code: "+222", flag: "🇲🇷", label: "MR", name: "Mauritania" },
  { code: "+230", flag: "🇲🇺", label: "MU", name: "Mauritius" },
  { code: "+52", flag: "🇲🇽", label: "MX", name: "Mexico" },
  { code: "+373", flag: "🇲🇩", label: "MD", name: "Moldova" },
  { code: "+377", flag: "🇲🇨", label: "MC", name: "Monaco" },
  { code: "+976", flag: "🇲🇳", label: "MN", name: "Mongolia" },
  { code: "+382", flag: "🇲🇪", label: "ME", name: "Montenegro" },
  { code: "+212", flag: "🇲🇦", label: "MA", name: "Morocco" },
  { code: "+258", flag: "🇲🇿", label: "MZ", name: "Mozambique" },
  { code: "+95", flag: "🇲🇲", label: "MM", name: "Myanmar" },
  { code: "+264", flag: "🇳🇦", label: "NA", name: "Namibia" },
  { code: "+674", flag: "🇳🇷", label: "NR", name: "Nauru" },
  { code: "+977", flag: "🇳🇵", label: "NP", name: "Nepal" },
  { code: "+31", flag: "🇳🇱", label: "NL", name: "Netherlands" },
  { code: "+64", flag: "🇳🇿", label: "NZ", name: "New Zealand" },
  { code: "+505", flag: "🇳🇮", label: "NI", name: "Nicaragua" },
  { code: "+227", flag: "🇳🇪", label: "NE", name: "Niger" },
  { code: "+234", flag: "🇳🇬", label: "NG", name: "Nigeria" },
  { code: "+850", flag: "🇰🇵", label: "KP", name: "North Korea" },
  { code: "+389", flag: "🇲🇰", label: "MK", name: "North Macedonia" },
  { code: "+47", flag: "🇳🇴", label: "NO", name: "Norway" },
  { code: "+968", flag: "🇴🇲", label: "OM", name: "Oman" },
  { code: "+92", flag: "🇵🇰", label: "PK", name: "Pakistan" },
  { code: "+680", flag: "🇵🇼", label: "PW", name: "Palau" },
  { code: "+970", flag: "🇵🇸", label: "PS", name: "Palestine" },
  { code: "+507", flag: "🇵🇦", label: "PA", name: "Panama" },
  { code: "+675", flag: "🇵🇬", label: "PG", name: "Papua New Guinea" },
  { code: "+595", flag: "🇵🇾", label: "PY", name: "Paraguay" },
  { code: "+51", flag: "🇵🇪", label: "PE", name: "Peru" },
  { code: "+63", flag: "🇵🇭", label: "PH", name: "Philippines" },
  { code: "+48", flag: "🇵🇱", label: "PL", name: "Poland" },
  { code: "+351", flag: "🇵🇹", label: "PT", name: "Portugal" },
  { code: "+974", flag: "🇶🇦", label: "QA", name: "Qatar" },
  { code: "+40", flag: "🇷🇴", label: "RO", name: "Romania" },
  { code: "+7", flag: "🇷🇺", label: "RU", name: "Russia" },
  { code: "+250", flag: "🇷🇼", label: "RW", name: "Rwanda" },
  { code: "+1869", flag: "🇰🇳", label: "KN", name: "Saint Kitts & Nevis" },
  { code: "+1758", flag: "🇱🇨", label: "LC", name: "Saint Lucia" },
  { code: "+685", flag: "🇼🇸", label: "WS", name: "Samoa" },
  { code: "+378", flag: "🇸🇲", label: "SM", name: "San Marino" },
  { code: "+966", flag: "🇸🇦", label: "SA", name: "Saudi Arabia" },
  { code: "+221", flag: "🇸🇳", label: "SN", name: "Senegal" },
  { code: "+381", flag: "🇷🇸", label: "RS", name: "Serbia" },
  { code: "+248", flag: "🇸🇨", label: "SC", name: "Seychelles" },
  { code: "+232", flag: "🇸🇱", label: "SL", name: "Sierra Leone" },
  { code: "+65", flag: "🇸🇬", label: "SG", name: "Singapore" },
  { code: "+421", flag: "🇸🇰", label: "SK", name: "Slovakia" },
  { code: "+386", flag: "🇸🇮", label: "SI", name: "Slovenia" },
  { code: "+677", flag: "🇸🇧", label: "SB", name: "Solomon Islands" },
  { code: "+252", flag: "🇸🇴", label: "SO", name: "Somalia" },
  { code: "+27", flag: "🇿🇦", label: "ZA", name: "South Africa" },
  { code: "+82", flag: "🇰🇷", label: "KR", name: "South Korea" },
  { code: "+211", flag: "🇸🇸", label: "SS", name: "South Sudan" },
  { code: "+34", flag: "🇪🇸", label: "ES", name: "Spain" },
  { code: "+94", flag: "🇱🇰", label: "LK", name: "Sri Lanka" },
  { code: "+249", flag: "🇸🇩", label: "SD", name: "Sudan" },
  { code: "+597", flag: "🇸🇷", label: "SR", name: "Suriname" },
  { code: "+46", flag: "🇸🇪", label: "SE", name: "Sweden" },
  { code: "+41", flag: "🇨🇭", label: "CH", name: "Switzerland" },
  { code: "+963", flag: "🇸🇾", label: "SY", name: "Syria" },
  { code: "+886", flag: "🇹🇼", label: "TW", name: "Taiwan" },
  { code: "+992", flag: "🇹🇯", label: "TJ", name: "Tajikistan" },
  { code: "+255", flag: "🇹🇿", label: "TZ", name: "Tanzania" },
  { code: "+66", flag: "🇹🇭", label: "TH", name: "Thailand" },
  { code: "+670", flag: "🇹🇱", label: "TL", name: "Timor-Leste" },
  { code: "+228", flag: "🇹🇬", label: "TG", name: "Togo" },
  { code: "+676", flag: "🇹🇴", label: "TO", name: "Tonga" },
  { code: "+1868", flag: "🇹🇹", label: "TT", name: "Trinidad & Tobago" },
  { code: "+216", flag: "🇹🇳", label: "TN", name: "Tunisia" },
  { code: "+90", flag: "🇹🇷", label: "TR", name: "Turkey" },
  { code: "+993", flag: "🇹🇲", label: "TM", name: "Turkmenistan" },
  { code: "+688", flag: "🇹🇻", label: "TV", name: "Tuvalu" },
  { code: "+256", flag: "🇺🇬", label: "UG", name: "Uganda" },
  { code: "+380", flag: "🇺🇦", label: "UA", name: "Ukraine" },
  { code: "+971", flag: "🇦🇪", label: "AE", name: "United Arab Emirates" },
  { code: "+598", flag: "🇺🇾", label: "UY", name: "Uruguay" },
  { code: "+998", flag: "🇺🇿", label: "UZ", name: "Uzbekistan" },
  { code: "+678", flag: "🇻🇺", label: "VU", name: "Vanuatu" },
  { code: "+58", flag: "🇻🇪", label: "VE", name: "Venezuela" },
  { code: "+84", flag: "🇻🇳", label: "VN", name: "Vietnam" },
  { code: "+967", flag: "🇾🇪", label: "YE", name: "Yemen" },
  { code: "+260", flag: "🇿🇲", label: "ZM", name: "Zambia" },
  { code: "+263", flag: "🇿🇼", label: "ZW", name: "Zimbabwe" },
] as const;

/** Map ISO country label to dial code for locale auto-detection */
const LABEL_TO_CODE: Record<string, string> = {};
COUNTRY_CODES.forEach(c => { LABEL_TO_CODE[c.label] = c.code; });

/**
 * Detect the user's country code from browser locale.
 * Returns the dial code (e.g. "+91") or the provided fallback.
 */
export function detectCountryCode(fallback = "+44"): string {
  try {
    const locale = navigator.language || (navigator as any).userLanguage || '';
    const parts = locale.split('-');
    const region = (parts[1] || '').toUpperCase();
    if (region && LABEL_TO_CODE[region]) return LABEL_TO_CODE[region];
  } catch { /* ignore */ }
  return fallback;
}

/** Default residential country for driver signup (ISO alpha-2). */
export const DEFAULT_COUNTRY_ISO = "GB";

const ISO_TO_COUNTRY = new Map<string, CountryCode>();
const NAME_TO_COUNTRY = new Map<string, CountryCode>();
for (const entry of COUNTRY_CODES) {
  ISO_TO_COUNTRY.set(entry.label, entry);
  NAME_TO_COUNTRY.set(entry.name.toLowerCase(), entry);
}

export function findCountryByIso(iso: string): CountryCode | undefined {
  return ISO_TO_COUNTRY.get(iso.trim().toUpperCase());
}

export function findCountryByName(name: string): CountryCode | undefined {
  return NAME_TO_COUNTRY.get(name.trim().toLowerCase());
}

export function getDefaultCountry(): CountryCode {
  return findCountryByIso(DEFAULT_COUNTRY_ISO) ?? COUNTRY_CODES[0];
}

export function isKnownCountryIso(iso: string): boolean {
  return ISO_TO_COUNTRY.has(iso.trim().toUpperCase());
}

export function searchWorldCountries(query: string): CountryCode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...COUNTRY_CODES];
  return COUNTRY_CODES.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.label.toLowerCase().includes(q) ||
      c.code.includes(q),
  );
}

export function formatCountryWithFlag(countryName?: string | null, countryCode?: string | null): string {
  const entry =
    (countryCode ? findCountryByIso(countryCode) : undefined) ??
    (countryName ? findCountryByName(countryName) : undefined);
  if (entry) return `${entry.flag} ${entry.name}`;
  return countryName?.trim() || "—";
}
