import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { findCountryByIso } from "@/lib/countryCodes";
import { CountryPickerSheet } from "@/components/CountryPickerSheet";

type CountrySelectorFieldProps = {
  countryCode: string;
  countryName: string;
  onSelect: (iso: string, name: string) => void;
  disabled?: boolean;
  error?: string;
  label?: string;
};

export function CountrySelectorField({
  countryCode,
  countryName,
  onSelect,
  disabled = false,
  error,
  label = "Country *",
}: CountrySelectorFieldProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const entry = findCountryByIso(countryCode);
  const displayFlag = entry?.flag ?? "🏳️";
  const displayName = entry?.name ?? countryName;

  return (
    <div className="space-y-2">
      <label className="text-sm text-muted-foreground">{label}</label>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setPickerOpen(true)}
        className={`flex h-10 w-full items-center justify-between rounded-md border bg-background px-3 text-sm text-left
          ${error ? "border-destructive" : "border-input"}
          disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <span className="flex items-center gap-2 truncate">
          <span className="text-lg leading-none">{displayFlag}</span>
          <span className="truncate">{displayName}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
      </button>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <CountryPickerSheet
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(iso, name) => {
          onSelect(iso, name);
          setPickerOpen(false);
        }}
        selectedIso={countryCode}
      />
    </div>
  );
}
