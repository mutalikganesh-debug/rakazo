export const APPEARANCE_PREFERENCES = ["system", "light", "dark"] as const;

export type AppearancePreference = (typeof APPEARANCE_PREFERENCES)[number];

export type ResolvedAppearance = "light" | "dark";

export const UI_APPEARANCE_STORAGE_KEY = "rakazo.uiAppearance";

/**
 * Semantic palette shared by web, Electron, and Expo. Names follow the shadcn
 * convention so the same slot means the same thing on every surface: a `border`
 * is always a border and never a fill.
 */
export type ColorTokens = {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  chatUser: string;
  chatUserForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
  sidebar: string;
  sidebarForeground: string;
  sidebarBorder: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  /** Solid fill behind the selected/active item in any nav or menu. */
  navSelectedBg: string;
  /** Foreground (text/icons) on `navSelectedBg`. */
  navSelectedFg: string;
  /** Left indicator bar on a selected nav row. */
  navSelectedIndicator: string;
  link: string;
  /** Backing behind a link's site icon. White in both themes so dark logos stay visible. */
  faviconPlate: string;
  success: string;
  warning: string;
  statusWorking: string;
  overlay: string;
  scrollbar: string;
  scrollbarHover: string;
};

export const darkTokens = {
  background: "#1A1633",
  foreground: "#ECEBFF",
  card: "#251D52",
  cardForeground: "#ECEBFF",
  popover: "#251D52",
  popoverForeground: "#ECEBFF",
  primary: "#6D4AFF",
  primaryForeground: "#FFFFFF",
  secondary: "#2E2465",
  secondaryForeground: "#ECEBFF",
  chatUser: "#1D3563",
  chatUserForeground: "#ECEBFF",
  muted: "#221A4C",
  mutedForeground: "#A79FD4",
  accent: "#322873",
  accentForeground: "#ECEBFF",
  destructive: "#FB7185",
  destructiveForeground: "#FFFFFF",
  border: "#372C78",
  input: "#262056",
  ring: "#8B7CFF",
  sidebar: "#120D2E",
  sidebarForeground: "#ECEBFF",
  sidebarBorder: "#2E2465",
  sidebarAccent: "#2B2160",
  sidebarAccentForeground: "#ECEBFF",
  navSelectedBg: "#5B3FE8",
  navSelectedFg: "#F5F6F8",
  navSelectedIndicator: "#67E8F9",
  link: "#22D3EE",
  faviconPlate: "#FFFFFF",
  success: "#34D399",
  warning: "#FBBF24",
  statusWorking: "#22D3EE",
  overlay: "rgba(12, 8, 32, 0.72)",
  scrollbar: "#2E2465",
  scrollbarHover: "#43369B",
} as const satisfies ColorTokens;

export const lightTokens = {
  background: "#FAFAF8",
  foreground: "#1A1A1A",
  card: "#FFFFFF",
  cardForeground: "#1A1A1A",
  popover: "#FFFFFF",
  popoverForeground: "#1A1A1A",
  primary: "#1A1A1A",
  primaryForeground: "#F1F1EF",
  secondary: "#F0F0ED",
  secondaryForeground: "#1A1A1A",
  chatUser: "#E2E2DC",
  chatUserForeground: "#1A1A1A",
  muted: "#F0F0ED",
  mutedForeground: "#6C6C70",
  accent: "#EAEAE6",
  accentForeground: "#1A1A1A",
  destructive: "#DC2626",
  destructiveForeground: "#FFFFFF",
  border: "#F0F0ED",
  input: "#EAEAE6",
  ring: "#6C6C70",
  sidebar: "#ECECE9",
  sidebarForeground: "#1A1A1A",
  sidebarBorder: "#E8E8E4",
  sidebarAccent: "#FFFFFF",
  sidebarAccentForeground: "#1A1A1A",
  navSelectedBg: "#2563EB",
  navSelectedFg: "#FFFFFF",
  navSelectedIndicator: "#FFFFFF",
  link: "#2563EB",
  faviconPlate: "#FFFFFF",
  success: "#228B3B",
  warning: "#B7791F",
  statusWorking: "#2563EB",
  overlay: "rgba(20, 20, 22, 0.45)",
  scrollbar: "#C8C8C4",
  scrollbarHover: "#A8A8A4",
} as const satisfies ColorTokens;

/** Dark palette. Prefer `tokensForAppearance` when theme-aware. */
export const tokens = darkTokens;

/** Dark-only effect layer: gradient washes and coloured glows. CSS strings for
 * web/desktop; scoped to `[data-theme="dark"]` in `tokens.css` so the light
 * theme keeps its flat surfaces. */
export const darkGradients = {
  /** Main app surface — deep indigo drifting through violet to blue-teal. */
  gradientSurface: "linear-gradient(160deg, #1a1633 0%, #171038 34%, #14123f 62%, #102242 100%)",
  /** Card / panel lift. */
  gradientPanel: "linear-gradient(180deg, #2a2060, #221a4c)",
  /** Accent (primary) buttons and gradient fills. */
  gradientAccent: "linear-gradient(135deg, #6d4aff, #2e63dc)",
  gradientAccentHover: "linear-gradient(135deg, #7e63ff, #3e74f0)",
  /** Selected/active nav and menu rows. */
  gradientSelected: "linear-gradient(120deg, #5b3fe8, #2e63dc)",
  /** Subtle coloured depth glows. */
  glowSelected: "0 4px 18px -6px rgba(109, 74, 255, 0.45)",
  glowButton: "0 4px 16px -4px rgba(109, 74, 255, 0.4)",
} as const;

export const RADIUS = "0.75rem";

export const botColors = [
  "#3EC5A8",
  "#F5A03C",
  "#6A6BF5",
  "#9B5CF6",
  "#3B82F6",
  "#F2622A",
  "#D9508A",
] as const;

export function isAppearancePreference(
  value: string | null | undefined,
): value is AppearancePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function normalizeAppearancePreference(
  raw: string | null | undefined,
): AppearancePreference {
  return isAppearancePreference(raw) ? raw : "system";
}

export type ResolveAppearancePreferenceOptions = {
  stored?: string | null;
  storage?: Pick<Storage, "getItem"> | null;
};

function getLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function resolveAppearancePreference(
  options: ResolveAppearancePreferenceOptions = {},
): AppearancePreference {
  const stored =
    options.stored !== undefined
      ? options.stored
      : readStoredAppearance(options.storage ?? getLocalStorage());
  return normalizeAppearancePreference(stored);
}

export function persistAppearancePreference(
  preference: AppearancePreference,
  storage: Pick<Storage, "setItem"> | null = getLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(UI_APPEARANCE_STORAGE_KEY, preference);
  } catch {
    // Ignore quota / private-mode failures; in-memory preference still applies.
  }
}

export function resolveAppearance(
  preference: AppearancePreference,
  system: ResolvedAppearance = "dark",
): ResolvedAppearance {
  if (preference === "system") return system;
  return preference;
}

export function tokensForAppearance(appearance: ResolvedAppearance): ColorTokens {
  return appearance === "light" ? lightTokens : darkTokens;
}

function readStoredAppearance(storage: Pick<Storage, "getItem"> | null | undefined): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(UI_APPEARANCE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** `cardForeground` -> `--card-foreground` */
export function cssVariableName(token: string): string {
  return `--${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function renderBlock(selector: string, colorScheme: ResolvedAppearance, palette: ColorTokens) {
  const lines = (Object.keys(palette) as (keyof ColorTokens)[]).map(
    (token) => `  ${cssVariableName(token)}: ${palette[token].toLowerCase()};`,
  );
  return `${selector} {\n  color-scheme: ${colorScheme};\n${lines.join("\n")}\n  --radius: ${RADIUS};\n}`;
}

/** Dark-only gradient/glow layer. Separate `[data-theme="dark"]` scope (not
 * `:root`) so light mode keeps its flat surfaces with zero light-theme work. */
function renderDarkGradientBlock(): string {
  const lines = (Object.keys(darkGradients) as (keyof typeof darkGradients)[]).map(
    (token) => `  ${cssVariableName(token)}: ${darkGradients[token]};`,
  );
  return `[data-theme="dark"] {\n${lines.join("\n")}\n}`;
}

/** The CSS in `tokens.css`. Generated from the TS palette so both stay in sync. */
export function renderTokensCss(): string {
  return `${[
    "/* Generated by `pnpm --filter @rakazo/ui-tokens generate`. Edit src/index.ts instead. */",
    renderBlock(':root,\n[data-theme="dark"]', "dark", darkTokens),
    renderBlock('[data-theme="light"]', "light", lightTokens),
    renderDarkGradientBlock(),
  ].join("\n\n")}\n`;
}
