/**
 * The app's semantic colours: one per priority, plus reminders. Built in
 * OKLCH so every hue reads at the same lightness in both themes.
 */
export type CategoryKey = "reminder" | "high" | "medium" | "low" | "none";

export interface CategoryColorSet {
  solid: string;
  ink: string;
  soft: string;
  edge: string;
  tile: string;
  name: string;
  hue: number;
}

const CATEGORIES: Record<CategoryKey, { hue: number; name: string }> = {
  reminder: { hue: 265, name: "Reminder" },
  high: { hue: 25, name: "High" },
  medium: { hue: 75, name: "Medium" },
  low: { hue: 230, name: "Low" },
  none: { hue: 260, name: "None" },
};

function catColor(hue: number, dark: boolean) {
  if (dark) {
    return {
      solid: `oklch(0.76 0.16 ${hue})`,
      ink: `oklch(0.88 0.08 ${hue})`,
      soft: `oklch(0.30 0.07 ${hue} / 0.55)`,
      edge: `oklch(0.45 0.10 ${hue} / 0.55)`,
      tile: `oklch(0.32 0.085 ${hue})`,
    };
  }
  return {
    solid: `oklch(0.56 0.16 ${hue})`,
    ink: `oklch(0.40 0.16 ${hue})`,
    soft: `oklch(0.95 0.04 ${hue})`,
    edge: `oklch(0.85 0.06 ${hue})`,
    tile: `oklch(0.95 0.04 ${hue})`,
  };
}

export function buildCategoryColors(
  dark: boolean,
): Record<CategoryKey, CategoryColorSet> {
  return Object.fromEntries(
    Object.entries(CATEGORIES).map(([k, v]) => [
      k,
      { ...v, ...catColor(v.hue, dark) },
    ]),
  ) as Record<CategoryKey, CategoryColorSet>;
}

export const CATEGORY_KEYS = Object.keys(CATEGORIES) as CategoryKey[];
