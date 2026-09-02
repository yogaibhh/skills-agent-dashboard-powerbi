/**
 * Visual builders - the catalog from references/visual-catalog.md, expressed as code.
 *
 * The point of the MCP server is that callers pick a visual type and name the fields; they never
 * hand-write queryState, literal encodings, or projection shapes. Those are the parts that break
 * silently when an LLM types them.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Bindings, FieldRef, Position, SCHEMA, newPbirName, queryState, writeJson } from './pbir.js';
import { buildTopNFilter } from './filters.js';

/** Roles each visual type accepts. Only types verified against real PBIR output are listed. */
export const ROLES: Record<string, string[]> = {
  cardVisual: ['Data'],
  card: ['Values'],
  multiRowCard: ['Values'],
  slicer: ['Values'],
  barChart: ['Category', 'Y', 'Series'],
  columnChart: ['Category', 'Y', 'Series'],
  clusteredBarChart: ['Category', 'Y', 'Series'],
  clusteredColumnChart: ['Category', 'Y', 'Series'],
  stackedBarChart: ['Category', 'Y', 'Series'],
  stackedColumnChart: ['Category', 'Y', 'Series'],
  lineChart: ['Category', 'Y', 'Series'],
  areaChart: ['Category', 'Y', 'Series'],
  stackedAreaChart: ['Category', 'Y', 'Series'],
  pieChart: ['Category', 'Y'],
  donutChart: ['Category', 'Y'],
  tableEx: ['Values'],
  scatterChart: ['Category', 'X', 'Y', 'Size'],
  pivotTable: ['Rows', 'Columns', 'Values'],
  textbox: [],
  image: [],
};

/**
 * Types that exist but whose role names shift between Power BI versions. The server refuses to guess
 * for these: harvest the real schema first (see harvest-visual-schema.ps1), then pass roles explicitly.
 */
export const UNVERIFIED_TYPES = new Set([
  'gauge',
  'kpi',
  'treemap',
  'funnel',
  'waterfallChart',
  'lineStackedColumnComboChart',
  'lineClusteredColumnComboChart',
  'map',
  'filledMap',
  'shapeMap',
  'ribbonChart',
]);

// --- literal encoding -------------------------------------------------------------------------
// The suffix carries the type. Get it wrong and the setting is dropped with no error.

const lit = (value: string) => ({ expr: { Literal: { Value: value } } });
export const litText = (value: string) => lit(`'${value.replace(/'/g, "''")}'`);
export const litInt = (value: number) => lit(`${Math.round(value)}L`);
export const litNum = (value: number) => lit(`${value}D`);
export const litBool = (value: boolean) => lit(value ? 'true' : 'false');

// ---------------------------------------------------------------------------------------------

export interface BuildVisualOptions {
  visualType: string;
  position: Position;
  name?: string;
  bindings?: Bindings;
  /** Container title. Omit for the default (the field name); pass null to hide it. */
  title?: string | null;
  /** textbox only. */
  text?: string;
  textSize?: number;
  /** Sort the visual by one of its bound measures. */
  sortBy?: { table: string; field: string; kind?: 'Measure' | 'Column'; direction?: 'Ascending' | 'Descending' };
  /** slicer only: Between (dates), Dropdown, Basic. */
  slicerMode?: 'Between' | 'Dropdown' | 'Basic';
  /** cardVisual only: how many cards per row. Defaults to the number of measures. */
  columnCount?: number;
  /** Merged into visual.objects verbatim, for anything the builder does not cover. */
  objects?: Record<string, unknown>;
  /**
   * Keep only the top N members of the visual's category, ranked by a measure. The honest fix for a
   * category with thousands of members - sorting alone still draws every bar.
   */
  topN?: { count: number; measure?: FieldRef; direction?: 'Ascending' | 'Descending' };
}

export function buildVisual(options: BuildVisualOptions): Record<string, unknown> {
  const {
    visualType,
    position,
    bindings = {},
    title,
    text,
    textSize = 24,
    sortBy,
    slicerMode,
    columnCount,
  } = options;

  const known = ROLES[visualType];
  if (known && known.length > 0) {
    for (const role of Object.keys(bindings)) {
      if (!known.includes(role)) {
        throw new Error(
          `'${visualType}' does not accept role '${role}'. Accepted: ${known.join(', ')}.`,
        );
      }
    }
  } else if (!known && UNVERIFIED_TYPES.has(visualType) && Object.keys(bindings).length === 0) {
    throw new Error(
      `'${visualType}' role names vary between Power BI versions, so bindings cannot be inferred. ` +
        `Author one in Desktop, harvest its schema, and pass the roles explicitly.`,
    );
  }

  const objects: Record<string, unknown> = { ...(options.objects ?? {}) };
  const containerObjects: Record<string, unknown> = {};

  if (visualType === 'textbox') {
    if (!text) throw new Error('A textbox needs text.');
    objects.general = [
      {
        properties: {
          paragraphs: [
            {
              textRuns: [
                {
                  value: text,
                  textStyle: { fontFamily: 'Segoe UI Semibold', fontSize: `${textSize}pt`, color: '#252423' },
                },
              ],
            },
          ],
        },
      },
    ];
  }

  if (visualType === 'slicer' && slicerMode) {
    objects.data = [{ properties: { mode: litText(slicerMode) } }];
  }

  if (visualType === 'cardVisual') {
    const measures = bindings.Data?.length ?? 0;
    const count = columnCount ?? Math.max(1, Math.min(4, measures));
    objects.layout = [
      {
        properties: {
          orientation: litNum(0),
          columnCount: litInt(count),
          alignment: litText('middle'),
          style: litText('Cards'),
        },
      },
    ];
    objects.value = [{ properties: { fontSize: litNum(28) }, selector: { id: 'default' } }];
    objects.accentBar = [{ properties: { show: litBool(false) }, selector: { id: 'default' } }];
  }

  if (title === null) {
    containerObjects.title = [{ properties: { show: litBool(false) } }];
  } else if (typeof title === 'string' && title.length > 0) {
    containerObjects.title = [{ properties: { show: litBool(true), text: litText(title) } }];
  }

  const visual: Record<string, unknown> = { visualType };

  const state = queryState(bindings);
  const query: Record<string, unknown> | undefined = state ? { queryState: state } : undefined;

  if (sortBy) {
    if (!query) {
      throw new Error('sortBy needs bindings to sort - a visual with no fields cannot be sorted.');
    }
    // sortDefinition lives INSIDE query, beside queryState. Power BI silently degrades a visual that
    // carries it as a sibling of query: the sort is ignored, and a table drops every projection after
    // the first. Verified against three visuals in a Desktop-authored report.
    const kind = sortBy.kind ?? 'Measure';
    query.sortDefinition = {
      sort: [
        {
          field: { [kind]: { Expression: { SourceRef: { Entity: sortBy.table } }, Property: sortBy.field } },
          direction: sortBy.direction ?? 'Descending',
        },
      ],
      // Desktop writes false for a sort the author chose; true would mark it as the visual's default.
      isDefaultSort: false,
    };
  }

  if (query) visual.query = query;

  if (Object.keys(objects).length > 0) visual.objects = objects;
  if (Object.keys(containerObjects).length > 0) visual.visualContainerObjects = containerObjects;
  visual.drillFilterOtherVisuals = true;

  const result: Record<string, unknown> = {
    $schema: SCHEMA.visual,
    name: options.name ?? newPbirName(),
    position,
    visual,
  };

  if (options.topN) {
    // Rank by the explicit measure, else by whatever the visual already plots.
    const measure =
      options.topN.measure ??
      (sortBy && (sortBy.kind ?? 'Measure') === 'Measure'
        ? { table: sortBy.table, field: sortBy.field, kind: 'Measure' as const }
        : undefined) ??
      (bindings.Y ?? bindings.Values ?? bindings.Data ?? []).find((f) => f.kind === 'Measure');

    const category = (bindings.Category ?? bindings.Rows ?? [])[0];

    if (!category) throw new Error('topN needs a Category (or Rows) binding to limit.');
    if (!measure) throw new Error('topN needs a measure to rank by - bind one, or pass topN.measure.');

    // filterConfig sits at the root of visual.json, beside name and position, not inside visual.
    result.filterConfig = {
      filters: [
        buildTopNFilter({
          category,
          measure,
          top: options.topN.count,
          direction: options.topN.direction,
        }),
      ],
    };
  }

  return result;
}

export interface WriteVisualOptions extends BuildVisualOptions {
  reportPath: string;
  pageFolder: string;
  visualFolder: string;
  overwrite?: boolean;
}

export async function writeVisual(options: WriteVisualOptions): Promise<{ path: string; name: string }> {
  const dir = path.join(
    options.reportPath,
    'definition',
    'pages',
    options.pageFolder,
    'visuals',
    options.visualFolder,
  );
  const file = path.join(dir, 'visual.json');

  if (!options.overwrite) {
    try {
      await fs.access(file);
      throw new Error(
        `Visual '${options.visualFolder}' already exists on page '${options.pageFolder}'. Pass overwrite: true to replace it.`,
      );
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }

  const visual = buildVisual(options);
  await writeJson(file, visual);
  return { path: file, name: visual.name as string };
}

export async function removeVisual(
  reportPath: string,
  pageFolder: string,
  visualFolder: string,
): Promise<void> {
  const dir = path.join(reportPath, 'definition', 'pages', pageFolder, 'visuals', visualFolder);
  await fs.rm(dir, { recursive: true, force: true });
}

/** Convenience for the common case: one category column and one measure. */
export function categoryMeasureBindings(
  category: FieldRef,
  measure: FieldRef,
  series?: FieldRef,
): Bindings {
  const bindings: Bindings = { Category: [category], Y: [measure] };
  if (series) bindings.Series = [series];
  return bindings;
}
