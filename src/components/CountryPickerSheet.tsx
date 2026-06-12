import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { Search, X, Check } from "lucide-react";
import {
  COUNTRY_CODES,
  searchWorldCountries,
  type CountryCode,
} from "@/lib/countryCodes";
import { Input } from "@/components/ui/input";

const POPULAR_ISOS = ["GB", "IE", "US", "DE", "FR", "BE", "IN", "AU", "AE", "NG", "ZA", "KE"];

interface CountryPickerSheetProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (iso: string, name: string) => void;
  selectedIso: string;
}

const ROW_HEIGHT = 52;

export function CountryPickerSheet({
  isOpen,
  onClose,
  onSelect,
  selectedIso,
}: CountryPickerSheetProps) {
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setSearch("");
      setTimeout(() => searchRef.current?.focus(), 300);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  const { popular, rest } = useMemo(() => {
    const q = search.trim();
    if (q) {
      return { popular: [] as CountryCode[], rest: searchWorldCountries(q) };
    }
    const pop: CountryCode[] = [];
    const other: CountryCode[] = [];
    for (const c of COUNTRY_CODES) {
      if (POPULAR_ISOS.includes(c.label)) pop.push(c);
      else other.push(c);
    }
    pop.sort((a, b) => POPULAR_ISOS.indexOf(a.label) - POPULAR_ISOS.indexOf(b.label));
    return { popular: pop, rest: other };
  }, [search]);

  const handleSelect = useCallback(
    (iso: string, name: string) => {
      onSelect(iso, name);
      onClose();
    },
    [onSelect, onClose],
  );

  if (!isOpen) return null;

  const renderRow = (c: CountryCode, i: number) => {
    const isSelected = selectedIso === c.label;
    return (
      <button
        key={`${c.label}-${i}`}
        type="button"
        onClick={() => handleSelect(c.label, c.name)}
        className={`w-full flex items-center gap-3 px-4 text-left select-none
          ${isSelected ? "bg-primary/10" : "active:bg-muted/60"}
        `}
        style={{
          minHeight: ROW_HEIGHT,
          WebkitTapHighlightColor: "transparent",
        }}
      >
        <span className="text-2xl leading-none flex-shrink-0">{c.flag}</span>
        <span className="flex-1 text-[15px] font-medium text-foreground truncate">{c.name}</span>
        <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0">{c.code}</span>
        {isSelected && <Check className="w-4 h-4 text-primary flex-shrink-0 ml-1" />}
      </button>
    );
  };

  const totalResults = popular.length + rest.length;

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-background animate-fade-in"
      style={{
        paddingTop: "var(--safe-top, max(env(safe-area-inset-top, 0px), var(--cap-inset-top, 0px)))",
        paddingBottom: "max(env(safe-area-inset-bottom, 0px), var(--cap-inset-bottom, 0px))",
      }}
    >
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border flex-shrink-0">
        <button
          onClick={onClose}
          className="w-10 h-10 flex items-center justify-center rounded-full active:bg-muted/60"
          style={{ WebkitTapHighlightColor: "transparent" }}
          aria-label="Close"
        >
          <X className="w-5 h-5 text-foreground" />
        </button>
        <h2 className="text-lg font-semibold text-foreground flex-1">Select Country</h2>
      </div>

      <div className="px-4 py-3 border-b border-border flex-shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search country, code, or +44…"
            className="pl-10 h-11 text-base"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
          />
        </div>
      </div>

      <div
        ref={listRef}
        className="flex-1 overflow-y-auto overscroll-contain"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        {totalResults === 0 ? (
          <p className="text-center text-muted-foreground py-12 text-sm">No countries found</p>
        ) : (
          <>
            {popular.length > 0 && (
              <>
                <div className="px-4 pt-3 pb-1.5 sticky top-0 bg-background/95 backdrop-blur-sm z-10">
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Popular
                  </span>
                </div>
                {popular.map((c, i) => renderRow(c, i))}
                <div className="px-4 pt-3 pb-1.5 border-t border-border sticky top-0 bg-background/95 backdrop-blur-sm z-10">
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    All Countries
                  </span>
                </div>
              </>
            )}
            {rest.map((c, i) => renderRow(c, i + popular.length))}
            <div className="h-6" />
          </>
        )}
      </div>
    </div>
  );
}
