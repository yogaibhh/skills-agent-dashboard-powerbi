/**
 * The layout grid and the blueprints built on it.
 *
 * Canvas is 1280x720 with a 24px margin and a 12-column grid at a 16px gutter, so:
 *   width(n columns) = 104n - 16      x(column c) = 24 + 104(c - 1)
 * Every slot below satisfies those formulas, and every row ends at exactly x = 1256.
 */

import type { Position } from './pbir.js';

export const CANVAS = { width: 1280, height: 720, margin: 24, gutter: 16, columns: 12 } as const;

export function gridWidth(columns: number): number {
  return 104 * columns - 16;
}

export function gridX(column: number): number {
  return 24 + 104 * (column - 1);
}

/**
 * Taller bands, for layouts that give a visual the full height of the page rather than splitting it
 * into two rows. Every value still lands the bottom edge on 696.
 */
export const TALL_BANDS = {
  /** Header, then one 608px-high region: a rail, or a single dominant visual. */
  full: { y: 88, height: 608 },
  /** Header, KPI band, then one 480px region. */
  belowKpi: { y: 216, height: 480 },
  /** Two 296px rows under the header - taller than rowA/rowB, and only two of them. */
  halfTop: { y: 88, height: 296 },
  halfBottom: { y: 400, height: 296 },
} as const;

export const BANDS = {
  header: { y: 16, height: 56 },
  kpi: { y: 88, height: 112 },
  rowA: { y: 216, height: 232 },
  rowB: { y: 464, height: 232 },
  rowFull: { y: 216, height: 480 },
} as const;

/** What a slot is for. The generator uses this to decide which fields belong in it. */
export type SlotRole =
  | 'title'
  | 'dateSlicer'
  | 'categorySlicer'
  | 'kpiRow'
  | 'trend'
  | 'breakdown'
  | 'comparison'
  | 'composition'
  | 'matrix'
  | 'detailTable'
  /** One oversized number that the page is built around. */
  | 'heroMetric'
  /** Two measures plotted against each other, one point per category member. */
  | 'scatter';

export interface Slot {
  slot: string;
  role: SlotRole;
  visualType: string;
  position: Position;
  /** Why this slot exists, shown to the caller when listing blueprints. */
  purpose: string;
  /** Slots the generator may drop when the model cannot fill them. */
  optional?: boolean;
}

export interface Blueprint {
  name: string;
  description: string;
  useWhen: string;
  slots: Slot[];
}

function pos(x: number, y: number, width: number, height: number, z: number, tabOrder: number): Position {
  return { x, y, z, width, height, tabOrder };
}

const TITLE: Slot = {
  slot: 'title',
  role: 'title',
  visualType: 'textbox',
  position: pos(24, BANDS.header.y, gridWidth(6), BANDS.header.height, 9000, 6000),
  purpose: 'Names the dashboard. Always present.',
};

const DATE_SLICER: Slot = {
  slot: 'dateSlicer',
  role: 'dateSlicer',
  visualType: 'slicer',
  position: pos(gridX(10), BANDS.header.y, gridWidth(3), BANDS.header.height, 8000, 7000),
  purpose: 'Date range filter. Dropped when the model has no date table.',
  optional: true,
};

const KPI_ROW: Slot = {
  slot: 'kpiRow',
  role: 'kpiRow',
  visualType: 'cardVisual',
  position: pos(24, BANDS.kpi.y, gridWidth(12), BANDS.kpi.height, 5000, 5000),
  purpose: 'Up to four headline measures in one container.',
};

export const BLUEPRINTS: Record<string, Blueprint> = {
  'executive-overview': {
    name: 'executive-overview',
    description: 'KPI row, a trend, a breakdown, and detail underneath.',
    useWhen: 'The default. Use unless the request clearly calls for one of the others.',
    slots: [
      TITLE,
      DATE_SLICER,
      KPI_ROW,
      {
        slot: 'trend',
        role: 'trend',
        visualType: 'lineChart',
        position: pos(24, BANDS.rowA.y, gridWidth(8), BANDS.rowA.height, 4000, 2000),
        purpose: 'Main measure over the date column.',
        optional: true,
      },
      {
        slot: 'breakdown',
        role: 'breakdown',
        visualType: 'barChart',
        position: pos(gridX(9), BANDS.rowA.y, gridWidth(4), BANDS.rowA.height, 3000, 3000),
        purpose: 'Main measure by the primary category, sorted descending.',
      },
      {
        slot: 'detailTable',
        role: 'detailTable',
        visualType: 'tableEx',
        position: pos(24, BANDS.rowB.y, gridWidth(8), BANDS.rowB.height, 2000, 1000),
        purpose: 'Row-level detail.',
        optional: true,
      },
      {
        slot: 'composition',
        role: 'composition',
        visualType: 'donutChart',
        position: pos(gridX(9), BANDS.rowB.y, gridWidth(4), BANDS.rowB.height, 1000, 1500),
        purpose: 'Share of total by a small secondary category (2-7 values).',
        optional: true,
      },
    ],
  },

  'trend-analysis': {
    name: 'trend-analysis',
    description: 'A full-width time series above a coarser period chart and a table.',
    useWhen: 'The question is about change over time.',
    slots: [
      TITLE,
      DATE_SLICER,
      KPI_ROW,
      {
        slot: 'trend',
        role: 'trend',
        visualType: 'lineChart',
        position: pos(24, BANDS.rowA.y, gridWidth(12), BANDS.rowA.height, 4000, 2000),
        purpose: 'Main measure over the date column, full width.',
      },
      {
        slot: 'periodBars',
        role: 'comparison',
        visualType: 'columnChart',
        position: pos(24, BANDS.rowB.y, gridWidth(6), BANDS.rowB.height, 3000, 3000),
        purpose: 'The same measure at a coarser grain, or by category.',
        optional: true,
      },
      {
        slot: 'detailTable',
        role: 'detailTable',
        visualType: 'tableEx',
        position: pos(gridX(7), BANDS.rowB.y, gridWidth(6), BANDS.rowB.height, 2000, 1000),
        purpose: 'Row-level detail.',
        optional: true,
      },
    ],
  },

  comparison: {
    name: 'comparison',
    description: 'Two category charts above a matrix and a share chart.',
    useWhen: 'Comparing categories or segments against each other.',
    slots: [
      TITLE,
      DATE_SLICER,
      KPI_ROW,
      {
        slot: 'rankBars',
        role: 'breakdown',
        visualType: 'barChart',
        position: pos(24, BANDS.rowA.y, gridWidth(6), BANDS.rowA.height, 4000, 2000),
        purpose: 'Main measure by the primary category, sorted descending.',
      },
      {
        slot: 'groupedBars',
        role: 'comparison',
        visualType: 'clusteredColumnChart',
        position: pos(gridX(7), BANDS.rowA.y, gridWidth(6), BANDS.rowA.height, 3000, 3000),
        purpose: 'Secondary category on the axis, primary category as series.',
        optional: true,
      },
      {
        slot: 'matrix',
        role: 'matrix',
        visualType: 'pivotTable',
        position: pos(24, BANDS.rowB.y, gridWidth(8), BANDS.rowB.height, 2000, 1000),
        purpose: 'Both categories crossed, with one or two measures.',
        optional: true,
      },
      {
        slot: 'composition',
        role: 'composition',
        visualType: 'donutChart',
        position: pos(gridX(9), BANDS.rowB.y, gridWidth(4), BANDS.rowB.height, 1000, 1500),
        purpose: 'Share of total by the secondary category.',
        optional: true,
      },
    ],
  },

  'detail-table': {
    name: 'detail-table',
    description: 'A KPI row above one large table.',
    useWhen: 'The user wants rows, not charts.',
    slots: [
      { ...TITLE, position: pos(24, BANDS.header.y, gridWidth(5), BANDS.header.height, 9000, 6000) },
      {
        slot: 'categorySlicer',
        role: 'categorySlicer',
        visualType: 'slicer',
        position: pos(gridX(7), BANDS.header.y, gridWidth(3), BANDS.header.height, 8100, 7100),
        purpose: 'Filter by the primary category.',
        optional: true,
      },
      DATE_SLICER,
      KPI_ROW,
      {
        slot: 'table',
        role: 'detailTable',
        visualType: 'tableEx',
        position: pos(24, BANDS.rowFull.y, gridWidth(12), BANDS.rowFull.height, 4000, 1000),
        purpose: 'Detail columns plus one to three measures.',
      },
    ],
  },
};

// --- structurally different layouts ------------------------------------------------------------
// The four above all share one shape: header, KPI strip, 2x2 grid. Generating only those makes every
// report look like the last one. These three break that shape deliberately.

BLUEPRINTS['hero-metric'] = {
  name: 'hero-metric',
  description: 'One oversized number beside a large trend, with three supporting charts underneath.',
  useWhen: 'The report answers a single question and one number is the answer.',
  slots: [
    TITLE,
    DATE_SLICER,
    {
      slot: 'hero',
      role: 'heroMetric',
      visualType: 'cardVisual',
      position: pos(24, TALL_BANDS.halfTop.y, gridWidth(4), TALL_BANDS.halfTop.height, 5000, 5000),
      purpose: 'The headline number, given a quarter of the page so it reads first.',
    },
    {
      slot: 'trend',
      role: 'trend',
      visualType: 'lineChart',
      position: pos(gridX(5), TALL_BANDS.halfTop.y, gridWidth(8), TALL_BANDS.halfTop.height, 4000, 2000),
      purpose: 'How that number got there.',
      optional: true,
    },
    {
      slot: 'breakdown',
      role: 'breakdown',
      visualType: 'barChart',
      position: pos(24, TALL_BANDS.halfBottom.y, gridWidth(4), TALL_BANDS.halfBottom.height, 3000, 3000),
      purpose: 'Which categories drive it.',
    },
    {
      slot: 'comparison',
      role: 'comparison',
      visualType: 'columnChart',
      position: pos(gridX(5), TALL_BANDS.halfBottom.y, gridWidth(4), TALL_BANDS.halfBottom.height, 2000, 2500),
      purpose: 'A second cut of the same measure.',
      optional: true,
    },
    {
      slot: 'composition',
      role: 'composition',
      visualType: 'donutChart',
      position: pos(gridX(9), TALL_BANDS.halfBottom.y, gridWidth(4), TALL_BANDS.halfBottom.height, 1000, 1500),
      purpose: 'Share of total by a small category.',
      optional: true,
    },
  ],
};

BLUEPRINTS['sidebar-detail'] = {
  name: 'sidebar-detail',
  description: 'A narrow rail of KPIs down the left, with two large visuals filling the rest.',
  useWhen: 'The charts need room and the numbers are context rather than the point.',
  slots: [
    TITLE,
    DATE_SLICER,
    {
      slot: 'kpiRail',
      role: 'kpiRow',
      visualType: 'cardVisual',
      position: pos(24, TALL_BANDS.full.y, gridWidth(3), TALL_BANDS.full.height, 5000, 5000),
      purpose: 'KPIs stacked vertically down the side instead of across the top.',
    },
    {
      slot: 'trend',
      role: 'trend',
      visualType: 'lineChart',
      position: pos(gridX(4), TALL_BANDS.halfTop.y, gridWidth(9), TALL_BANDS.halfTop.height, 4000, 2000),
      purpose: 'The main time series, given real height.',
      optional: true,
    },
    {
      slot: 'breakdown',
      role: 'breakdown',
      visualType: 'barChart',
      position: pos(gridX(4), TALL_BANDS.halfBottom.y, gridWidth(9), TALL_BANDS.halfBottom.height, 3000, 3000),
      purpose: 'A wide ranked breakdown - room for long category labels.',
    },
  ],
};

BLUEPRINTS['three-column'] = {
  name: 'three-column',
  description: 'A KPI strip over a three-by-two grid of equal panels.',
  useWhen: 'Several equally important cuts of the same measure, with no single hero.',
  slots: [
    TITLE,
    DATE_SLICER,
    KPI_ROW,
    {
      slot: 'trend',
      role: 'trend',
      visualType: 'lineChart',
      position: pos(24, BANDS.rowA.y, gridWidth(4), BANDS.rowA.height, 4000, 2000),
      purpose: 'Over time.',
      optional: true,
    },
    {
      slot: 'breakdown',
      role: 'breakdown',
      visualType: 'barChart',
      position: pos(gridX(5), BANDS.rowA.y, gridWidth(4), BANDS.rowA.height, 3900, 2100),
      purpose: 'By the primary category.',
    },
    {
      slot: 'composition',
      role: 'composition',
      visualType: 'donutChart',
      position: pos(gridX(9), BANDS.rowA.y, gridWidth(4), BANDS.rowA.height, 3800, 2200),
      purpose: 'Share of total.',
      optional: true,
    },
    {
      slot: 'comparison',
      role: 'comparison',
      visualType: 'columnChart',
      position: pos(24, BANDS.rowB.y, gridWidth(4), BANDS.rowB.height, 3000, 1000),
      purpose: 'A second category cut.',
      optional: true,
    },
    {
      slot: 'matrix',
      role: 'matrix',
      visualType: 'pivotTable',
      position: pos(gridX(5), BANDS.rowB.y, gridWidth(4), BANDS.rowB.height, 2000, 1100),
      purpose: 'Both categories crossed.',
      optional: true,
    },
    {
      slot: 'detailTable',
      role: 'detailTable',
      visualType: 'tableEx',
      position: pos(gridX(9), BANDS.rowB.y, gridWidth(4), BANDS.rowB.height, 1000, 1200),
      purpose: 'Row-level detail.',
      optional: true,
    },
  ],
};

export function getBlueprint(name: string): Blueprint {
  const bp = BLUEPRINTS[name];
  if (!bp) {
    throw new Error(`Unknown blueprint '${name}'. Available: ${Object.keys(BLUEPRINTS).join(', ')}`);
  }
  return bp;
}

export function getSlot(blueprintName: string, slotName: string): Slot {
  const bp = getBlueprint(blueprintName);
  const slot = bp.slots.find((s) => s.slot === slotName);
  if (!slot) {
    throw new Error(`Blueprint '${blueprintName}' has no slot '${slotName}'. Slots: ${bp.slots.map((s) => s.slot).join(', ')}`);
  }
  return slot;
}

/**
 * Adds a blueprint at runtime - used for harvested templates.
 *
 * Templates are allowed to shadow a built-in of the same name, because a team that harvested its own
 * 'executive-overview' means theirs; the caller is told when that happens.
 */
export function registerBlueprint(blueprint: Blueprint): { replaced: boolean } {
  const replaced = Object.prototype.hasOwnProperty.call(BLUEPRINTS, blueprint.name);
  BLUEPRINTS[blueprint.name] = blueprint;
  return { replaced };
}

export function isBuiltIn(name: string): boolean {
  return BUILT_IN_NAMES.has(name);
}

const BUILT_IN_NAMES = new Set(Object.keys(BLUEPRINTS));
