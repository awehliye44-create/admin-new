import { rgb, type RGB } from "npm:pdf-lib@1.17.1";

export const ONECAB = {
  gold: "#FFC107",
  goldLight: "#FFFBEB",
  black: "#000000",
  charcoal: "#121212",
  darkText: "#111827",
  mutedText: "#6B7280",
  lightBorder: "#E5E7EB",
  lightBg: "#F9FAFB",
  white: "#FFFFFF",
  positiveGreen: "#16A34A",
  deductionRed: "#EF4444",
} as const;

export function hexToRgb(hex: string): RGB {
  const normalized = hex.replace("#", "");
  return rgb(
    parseInt(normalized.slice(0, 2), 16) / 255,
    parseInt(normalized.slice(2, 4), 16) / 255,
    parseInt(normalized.slice(4, 6), 16) / 255,
  );
}

export const PDF_COLORS = {
  gold: hexToRgb(ONECAB.gold),
  goldLight: hexToRgb(ONECAB.goldLight),
  black: hexToRgb(ONECAB.black),
  charcoal: hexToRgb(ONECAB.charcoal),
  darkText: hexToRgb(ONECAB.darkText),
  mutedText: hexToRgb(ONECAB.mutedText),
  lightBorder: hexToRgb(ONECAB.lightBorder),
  lightBg: hexToRgb(ONECAB.lightBg),
  white: hexToRgb(ONECAB.white),
  positiveGreen: hexToRgb(ONECAB.positiveGreen),
  deductionRed: hexToRgb(ONECAB.deductionRed),
};
