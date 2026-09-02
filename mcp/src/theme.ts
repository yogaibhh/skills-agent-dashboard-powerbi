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

export type ThemePreset = 'light' | 'dark' | 'minimal' | 'corporate' | 'warm' | 'contrast' | 'editorial';

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

const DATA_COLORS_CORPORATE = [
  '#12395B', '#1B6E8C', '#3FA0A6', '#7FBF9B', '#C2A15A', '#A4553C', '#6B4E71', '#8A94A6',
];

const DATA_COLORS_WARM = [
  '#B5502F', '#D98E45', '#C9A227', '#7A8C4B', '#4E7A6B', '#8A5A44', '#B07C9E', '#8C7B6B',
];

const DATA_COLORS_CONTRAST = [
  '#005FCC', '#D65200', '#00785A', '#B10E4A', '#5B2D8E', '#00707A', '#8A6A00', '#3D4653',
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

  // Deep navy on a cool page. Reads as a bank or an ops report rather than a demo.
  corporate: {
    page: '#EEF1F6',
    outspace: '#E1E6EE',
    card: '#FFFFFF',
    border: '#D6DCE6',
    text: '#12233A',
    textMuted: '#546480',
    gridline: '#E4E9F0',
    divider: '#EDF0F5',
    dataColors: DATA_COLORS_CORPORATE,
    good: '#2E7D5B',
    neutral: '#C2A15A',
    bad: '#A4353C',
    shadow: false,
    radius: 4,
  },

  // Cream page, earthy palette. Softer than the default blue-grey without going pastel.
  warm: {
    page: '#FAF6F0',
    outspace: '#F1EAE0',
    card: '#FFFFFF',
    border: '#E8DFD3',
    text: '#2E2620',
    textMuted: '#6E6156',
    gridline: '#EFE7DC',
    divider: '#F3ECE3',
    dataColors: DATA_COLORS_WARM,
    good: '#5C7A4B',
    neutral: '#C9A227',
    bad: '#B5502F',
    shadow: true,
    radius: 12,
  },

  // Built for legibility: strong text, saturated series, heavier gridlines. Use on projectors,
  // in bright rooms, or when the audience includes low-vision readers.
  contrast: {
    // Still separated: white cards on a light grey page. High contrast is about legibility, and a
    // visual whose edge you cannot find is not legible.
    page: '#EDEEF0',
    outspace: '#DADDE1',
    card: '#FFFFFF',
    border: '#8A9099',
    text: '#000000',
    textMuted: '#3D4653',
    gridline: '#BFC5CC',
    divider: '#D4D9DE',
    dataColors: DATA_COLORS_CONTRAST,
    good: '#00785A',
    neutral: '#8A6A00',
    bad: '#B10E4A',
    shadow: false,
    radius: 0,
  },

  // Quiet and typographic: muted series, hairline borders, no fills competing with the data.
  editorial: {
    page: '#FCFCFA',
    outspace: '#F2F2EE',
    card: '#FFFFFF',
    border: '#E0E0DA',
    text: '#22252A',
    textMuted: '#63696F',
    gridline: '#ECECE7',
    divider: '#F1F1EC',
    dataColors: ['#3A4E63', '#9C6B4E', '#6E8B6E', '#A05B63', '#7A6E93', '#4E7F82', '#A8924E', '#7C838C'],
    good: '#5C7F5C',
    neutral: '#A8924E',
    bad: '#A05B63',
    shadow: false,
    radius: 2,
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
