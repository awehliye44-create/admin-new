import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface CompanyInfo {
  name: string;
  legalName: string;
  email: string;
  phone: string;
  website: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  taxId?: string;
  registrationNumber?: string;
}

export interface BrandingSettings {
  logoUrl: string;
  tagline: string;
}

const DEFAULT_COMPANY: CompanyInfo = {
  name: "ONECAB",
  legalName: "ONECAB",
  email: "",
  phone: "",
  website: "",
  address: "",
  city: "",
  state: "",
  zipCode: "",
  country: "",
};

const DEFAULT_BRANDING: BrandingSettings = {
  logoUrl: "",
  tagline: "ONE APP. EVERY JOURNEY.",
};

export function formatCompanyAddress(info: CompanyInfo): string {
  const parts = [
    info.address,
    [info.city, info.state].filter(Boolean).join(", "),
    info.zipCode,
    info.country,
  ].filter((p) => p && String(p).trim().length > 0);
  return parts.join(", ");
}

export async function fetchCompanyBranding(
  supabase: SupabaseClient,
): Promise<{ company: CompanyInfo; branding: BrandingSettings }> {
  const { data, error } = await supabase
    .from("admin_settings")
    .select("setting_key, setting_value")
    .in("setting_key", ["company_info", "branding_settings"]);

  if (error) console.warn("[DRIVER_INVOICE] branding fetch failed", error.message);

  const map = new Map((data ?? []).map((r) => [r.setting_key, r.setting_value]));
  const companyRaw = (map.get("company_info") ?? {}) as Partial<CompanyInfo>;
  const brandingRaw = (map.get("branding_settings") ?? {}) as Partial<BrandingSettings>;

  const company = { ...DEFAULT_COMPANY, ...companyRaw };
  return {
    company: { ...company, address: formatCompanyAddress(company) || company.address },
    branding: { ...DEFAULT_BRANDING, ...brandingRaw },
  };
}
