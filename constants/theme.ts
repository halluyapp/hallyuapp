import { Platform, TextStyle } from 'react-native';

/**
 * Hallyu design tokens (dark only, true-black OLED canvas, one crimson accent).
 * Source of truth: Hallyu UX/UI Specification v2 (design system) + docs/design/.
 */

export const palette = {
  ink1000: '#000000',
  ink950: '#0A0A0A',
  ink900: '#0F0F10',
  ink850: '#161618',
  ink800: '#1C1C1F',
  ink700: '#26262B',
  ink600: '#34343A',
  ink500: '#4B4B53',
  ink450: '#61616B',
  ink400: '#7A7A85',
  ink300: '#A1A1AA',
  ink200: '#C4C4CC',
  ink100: '#D6D6DC',
  white: '#F5F5F7',
  gray500: '#8E8E93',
  gray600: '#48484A',
  rose700: '#BE123C',
  rose600: '#E11D48',
  glow: '#FF1F4E',
  rose500: '#F43F5E',
  rose400: '#FB7185',
  rose300: '#FDA4AF',
  amber500: '#E8A33D',
  amber400: '#F2B84B',
  green400: '#34D399',
  liveGreen: '#22C55E',
  spoilerAmber: '#F59E0B',
  yellow400: '#FBBF24',
  red400: '#EF4444',
  blue400: '#60A5FA',
} as const;

export const colors = {
  /** True black — OLED base. */
  canvas: palette.ink1000,
  surface1: palette.ink900,
  surface2: palette.ink850,
  surface3: palette.ink800,
  /** Glass layers: 4% white fill, 6% white border, blurred backdrop. */
  glass: 'rgba(255,255,255,0.04)',
  glassBorder: 'rgba(255,255,255,0.06)',
  borderSubtle: palette.ink800,
  borderStrong: palette.ink450,
  textPrimary: palette.white,
  textSecondary: palette.gray500,
  // 4.95:1 on the canvas and 4.52:1 on surface1 — the previous #48484A measured 2.30:1, which is
  // below every legibility threshold there is. Tertiary still reads as the quietest text tier
  // because secondary and primary are lighter still; it is now quiet *and* readable.
  textTertiary: palette.ink400,
  // For genuinely disabled controls only. It is deliberately dim (2.30:1) and must not be used for
  // copy a member is meant to read — captions belong to `tertiary`.
  textDisabled: palette.gray600,
  // White, not the off-white canvas ink: on the crimson button #F5F5F7 measured 4.31:1, just under
  // the 4.5 a normal-weight label needs, and pure white measures 4.70:1.
  onAccent: '#FFFFFF',
  onMedia: palette.white,
  accent: palette.rose600,
  accentText: palette.rose600,
  /** Crimson glow for pulses and live moments. */
  accentGlow: palette.glow,
  accentPressed: palette.rose700,
  accentSoft: 'rgba(225,29,72,0.14)',
  /** Spoiler gate. */
  spoiler: palette.spoilerAmber,
  warm: palette.amber400,
  warmSoft: 'rgba(242,184,75,0.14)',
  /** Currently airing. */
  live: palette.liveGreen,
  success: palette.green400,
  warning: palette.yellow400,
  danger: palette.red400,
  dangerFill: palette.rose700,
  info: palette.blue400,
  veil: palette.ink850,
  overlay: 'rgba(0,0,0,0.56)',
  scrim: 'rgba(0,0,0,0.72)',
  skeleton: palette.ink800,
  skeletonHighlight: palette.ink700,
  reaction: {
    loved: palette.rose500,
    cried: palette.blue400,
    screamed: palette.yellow400,
    swooned: palette.rose300,
    laughed: palette.amber400,
    furious: palette.red400,
  },
} as const;

/** Font families are one-per-weight (React Native on Android cannot pick weights from a single family). */
export const fonts = {
  regular: 'Pretendard-Regular',
  medium: 'Pretendard-Medium',
  semibold: 'Pretendard-SemiBold',
  bold: 'Pretendard-Bold',
  extrabold: 'Pretendard-ExtraBold',
} as const;

const t = (fontSize: number, lineHeight: number, family: string, extra?: TextStyle): TextStyle => ({
  fontSize,
  lineHeight,
  fontFamily: family,
  color: colors.textPrimary,
  ...extra,
});

export const type = {
  /** --text-display 34/1.1/700 — drama titles, heroes, large numbers. */
  displayLarge: t(34, 38, fonts.extrabold, { letterSpacing: -0.6 }),
  display: t(34, 38, fonts.extrabold, { letterSpacing: -0.6 }),
  /** --text-title-1 28/1.2/700 — screen titles. */
  headline: t(28, 34, fonts.bold, { letterSpacing: -0.3 }),
  /** --text-title-2 22/1.25/600 — section heads. */
  titleLarge: t(22, 28, fonts.semibold, { letterSpacing: -0.2 }),
  /** --text-title-3 17/1.3/600 — card titles. */
  title: t(17, 22, fonts.semibold),
  titleSmall: t(17, 22, fonts.semibold),
  /** --text-body 16/1.5/400. */
  bodyLarge: t(16, 24, fonts.regular),
  body: t(16, 24, fonts.regular),
  /** --text-callout 15/1.4/400 — list items. */
  bodySmall: t(15, 21, fonts.regular),
  label: t(13, 17, fonts.semibold),
  /** --text-caption 13/1.35/500 — metadata. */
  caption: t(13, 18, fonts.medium, { color: colors.textSecondary }),
  /** --text-overline 11/1.2/600 uppercase, letter-spacing 0.08em. */
  overline: t(11, 13, fonts.bold, { letterSpacing: 0.88, textTransform: 'uppercase', color: colors.textSecondary }),
  button: t(15, 20, fonts.semibold),
  tabLabel: t(11, 14, fonts.semibold),
} as const;

export type TypeVariant = keyof typeof type;

export const space = {
  x1: 4,
  x2: 8,
  x3: 12,
  x4: 16,
  x5: 20,
  x6: 24,
  x8: 32,
  x10: 40,
  x12: 48,
  x16: 64,
  margin: 16,
  gutter: 12,
  section: 32,
} as const;

export const radius = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, full: 999 } as const;

export const sizes = {
  touch: 48,
  topBar: 56,
  tabBar: 64,
  /** left navigation rail on medium/expanded widths */
  rail: 80,
  /** Create circle — 56dp, radius 28, elevated above the tab pill. */
  createButton: 56,
  avatar: { xs: 24, sm: 32, md: 40, lg: 56, xl: 88 },
  poster: { s: 72, m: 104, l: 140, xl: 180 },
  readingColumn: 640,
  heroMax: 420,
} as const;

export const aspect = { poster: 2 / 3, backdrop: 16 / 9, short: 9 / 16, avatar: 1, postImage: 4 / 5 } as const;

export const motion = {
  /** --dur-micro. */
  instant: 80,
  /** --dur-fast. */
  short: 180,
  /** --dur-standard. */
  medium: 320,
  /** --dur-slow. */
  long: 480,
  /** --dur-hero. */
  slow: 700,
  livePulse: 1600,
  skeletonDelay: 150,
} as const;

/** Shadows are always pure black, never coloured. 1 cards · 2 floating · 3 sheets/modals. */
export const shadows = {
  card: { shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
  float: { shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: { width: 0, height: 8 }, elevation: 12 },
  modal: { shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 48, shadowOffset: { width: 0, height: 16 }, elevation: 24 },
} as const;

export const hairline = Platform.select({ ios: 0.5, default: 1 }) as number;

/** Window size classes (Material adaptive) */
export const breakpoints = { medium: 600, expanded: 840 } as const;
export type WindowClass = 'compact' | 'medium' | 'expanded';
export function windowClass(width: number): WindowClass {
  if (width >= breakpoints.expanded) return 'expanded';
  if (width >= breakpoints.medium) return 'medium';
  return 'compact';
}
export function marginFor(width: number) {
  const wc = windowClass(width);
  return wc === 'compact' ? 16 : wc === 'medium' ? 24 : 32;
}
