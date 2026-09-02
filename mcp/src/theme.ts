/**
 * Report themes.
 *
 * Power BI theme JSON is a separate, documented format from PBIR, and it fails benignly: Desktop
 * ignores a property it does not recognise rather than degrading the visual. That makes it the right
 * place to control how a report looks, and the wrong place to be timid.
 *
 * The default look is a light neutral page with white cards on it. A flat white page holding white
 * cards - which is what Power BI gives you out of the box - makes every visual edge disappear.
 */

export type ThemePreset = 'light' | 'dark' | 'minimal';

export interface ThemeOptions {
  preset?: ThemePreset;
  /** Primary colour. Becomes the first data colour and the table accent. */
  accent?: string;
  /** Full categorical palette. Overrides the preset's colours; first entry wins over `accent`. */
  dataColors?: string[];
  /** Canvas colour behind the visuals. Overrides the preset. */
  pageBackground?: string;
  /** Card colour. Overrides the preset. */
  visualBackground?: string;
  /** Corner radius on every visual container. 0 for square corners. */
  cornerRadius?: number;
  /** Soft shadow under each visual. On by default for light and dark, off for minimal. */
  shadow?: boolean;
  fontFamily?: string;
  name?: string;
}

interface Palette {
  page: string;
  outspace: string;
  card: string;
  border: string;
  text: string;
  textMuted: string;
  gridline: string;
  divider: string;
  dataColors: string[];
  good: string;
  neutral: string;
  bad: string;
  shadow: boolean;
  radius: number;
}

const DATA_COLORS_LIGHT = [
  '#2C5F9E',
  '#E07B39',
  '#3E9E6B',
  '#C0504D',
  '#7A5EA8',
  '#178A8F',
  '#C9A227',
  '#6B7B8C',
];

const DATA_COLORS_DARK = [
  '#5B9BD5',
  '#F0A05A',
  '#5FBF8B',
  '#E4736F',
  '#A084C9',
  '#3FB3B8',
  '#DCC04E',
  '#93A2B3',
];

const PRESETS: Record<ThemePreset, Palette> = {
  // Cards float on a slightly cool grey. This is the difference between a dashboard that reads as
  // panels and one that reads as a single white sheet.
  light: {
    page: '#F5F6FA',
    outspace: '#EBECF2',
    card: '#FFFFFF',
    border: '#E3E5EC',
    text: '#1F2328',
    textMuted: '#5A6270',
    gridline: '#E8EAEE',
    divider: '#EDEFF3',
    dataColors: DATA_COLORS_LIGHT,
    good: '#3E9E6B',
    neutral: '#C9A227',
    bad: '#C0504D',
    shadow: true,
    radius: 8,
  },
  dark: {
    page: '#181A1F',
    outspace: '#101216',
    card: '#22262E',
    border: '#31363F',
    text: '#E8EAED',
    textMuted: '#9BA3B0',
    gridline: '#2C313A',
    divider: '#2C313A',
    dataColors: DATA_COLORS_DARK,
    good: '#5FBF8B',
    neutral: '#DCC04E',
    bad: '#E4736F',
    shadow: false,
    radius: 8,
  },
  // No fills, no shadows - separation comes from whitespace alone. For print and dense reports.
  minimal: {
    page: '#FFFFFF',
    outspace: '#FFFFFF',
    card: '#FFFFFF',
    border: '#DDE0E6',
    text: '#1F2328',
    textMuted: '#5A6270',
    gridline: '#EDEFF3',
    divider: '#EDEFF3',
    dataColors: DATA_COLORS_LIGHT,
    good: '#3E9E6B',
    neutral: '#C9A227',
    bad: '#C0504D',
    shadow: false,
    radius: 0,
  },
};

const HEX = /^#[0-9a-fA-F]{6}$/;

function checkHex(value: string, label: string): string {
  if (!HEX.test(value)) {
    throw new Error(`${label} must be a 6-digit hex colour like "#2C5F9E", got "${value}".`);
  }
  return value.toUpperCase();
}

const solid = (color: string) => ({ solid: { color } });

export function buildTheme(options: ThemeOptions = {}): Record<string, unknown> {
  const preset = options.preset ?? 'light';
  const base = PRESETS[preset];
  if (!base) {
    throw new Error(`Unknown theme preset '${preset}'. Available: ${Object.keys(PRESETS).join(', ')}`);
  }

  const p: Palette = { ...base };

  if (options.dataColors && options.dataColors.length > 0) {
    p.dataColors = options.dataColors.map((c, i) => checkHex(c, `dataColors[${i}]`));
  }
  if (options.accent) {
    // The accent leads the palette; the rest of the preset's colours follow it.
    const accent = checkHex(options.accent, 'accent');
    p.dataColors = [accent, ...p.dataColors.filter((c) => c.toUpperCase() !== accent)].slice(0, 8);
  }
  if (options.pageBackground) p.page = checkHex(options.pageBackground, 'pageBackground');
  if (options.visualBackground) p.card = checkHex(options.visualBackground, 'visualBackground');
  if (typeof options.cornerRadius === 'number') {
    if (options.cornerRadius < 0 || options.cornerRadius > 40) {
      throw new Error('cornerRadius must be between 0 and 40.');
    }
    p.radius = Math.round(options.cornerRadius);
  }
  if (typeof options.shadow === 'boolean') p.shadow = options.shadow;

  const font = options.fontFamily ?? 'Segoe UI';
  const fontSemibold = `${font} Semibold`;
  const accent = p.dataColors[0];

  const theme: Record<string, unknown> = {
    name: options.name ?? `DashboardBuilder ${preset}`,
    dataColors: p.dataColors,

    // Structural colours. Power BI derives a lot of chrome from these, so setting them is what makes
    // a theme feel coherent rather than a recoloured default.
    background: p.card,
    secondaryBackground: p.page,
    foreground: p.text,
    tableAccent: accent,
    firstLevelElements: p.text,
    secondLevelElements: p.textMuted,
    thirdLevelElements: p.gridline,
    fourthLevelElements: p.divider,
    good: p.good,
    neutral: p.neutral,
    bad: p.bad,
    maximum: accent,
    minimum: p.page,
    center: p.gridline,

    textClasses: {
      callout: { fontFace: fontSemibold, fontSize: 28, color: p.text },
      title: { fontFace: fontSemibold, fontSize: 13, color: p.text },
      header: { fontFace: fontSemibold, fontSize: 11, color: p.text },
      label: { fontFace: font, fontSize: 10, color: p.textMuted },
    },

    visualStyles: {
      // The page canvas and the space around it.
      page: {
        '*': {
          background: [{ color: solid(p.page), transparency: 0 }],
          outspace: [{ color: solid(p.outspace), transparency: 0 }],
        },
      },

      '*': {
        '*': {
          background: [{ show: true, color: solid(p.card), transparency: 0 }],
          border: [{ show: true, color: solid(p.border), radius: p.radius }],
          dropShadow: p.shadow
            ? [{ show: true, color: solid('#000000'), position: 'Outer', preset: 'BottomRight' }]
            : [{ show: false }],
          title: [
            {
              show: true,
              fontColor: solid(p.text),
              background: solid(p.card),
              fontSize: 12,
              fontFamily: fontSemibold,
              alignment: 'left',
            },
          ],
          visualHeader: [{ show: false }],
          padding: [{ top: 8, bottom: 8, left: 10, right: 10 }],
        },
      },

      // Axes and gridlines: muted, so the data is the loudest thing on the page.
      barChart: { '*': { categoryAxis: [{ gridlineShow: false }] } },
      columnChart: { '*': { valueAxis: [{ gridlineColor: solid(p.gridline) }] } },
      lineChart: { '*': { valueAxis: [{ gridlineColor: solid(p.gridline) }] } },

      // Cards read as numbers, not as boxes: no border of their own inside the KPI strip.
      cardVisual: {
        '*': {
          border: [{ show: false }],
          background: [{ show: true, color: solid(p.card), transparency: 0 }],
        },
      },

      // A textbox used as a page title should not look like a panel.
      textbox: {
        '*': {
          background: [{ show: false }],
          border: [{ show: false }],
          dropShadow: [{ show: false }],
        },
      },

      slicer: {
        '*': {
          background: [{ show: true, color: solid(p.card), transparency: 0 }],
          border: [{ show: true, color: solid(p.border), radius: p.radius }],
        },
      },
    },
  };

  return theme;
}

export const THEME_PRESETS = Object.keys(PRESETS) as ThemePreset[];
