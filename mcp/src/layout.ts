/**
 * Layout harvesting: turn a real report into a reusable blueprint.
 *
 * The generator only knows the layouts someone hand-wrote for it, which is why generated reports
 * start to look alike. Any PBIR report you have the rights to is a layout worth stealing - this reads
 * one and produces a blueprint, inferring what each visual is *for* from its type and its bindings.
 *
 * Positions in a hand-drawn report are fractional (426.98, 216.32). Snapping them to the 12-column
 * grid keeps the shape while making the result align like the built-in blueprints; the caller is told
 * how far anything moved so a large drift can be spotted rather than silently accepted.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Blueprint, Slot, SlotRole, gridWidth, gridX } from './blueprints.js';
import { Bindings, Position, readReport } from './pbir.js';

const CANVAS_RIGHT = 1256;
const CANVAS_BOTTOM = 696;

/** Types that carry branding rather than structure - not worth keeping in a reusable layout. */
const DECORATION = new Set(['image', 'shape', 'basicShape']);

interface Inference {
  role: SlotRole;
  confidence: 'high' | 'medium' | 'low';
  why: string;
}

/** What is this visual for? Read from its type plus the shape of what it is bound to. */
function inferRole(visualType: string, bindings: Bindings, position: Position, dateTables: Set<string>): Inference {
  const roles = Object.keys(bindings);
  const fields = roles.flatMap((r) => bindings[r]);
  const measures = fields.filter((f) => f.kind === 'Measure');
  const boundToDate = fields.some((f) => dateTables.has(f.table));

  if (visualType === 'textbox') {
    return { role: 'title', confidence: 'high', why: 'a textbox at the top of a page is the title' };
  }

  if (visualType === 'slicer') {
    return boundToDate
      ? { role: 'dateSlicer', confidence: 'high', why: 'slicer bound to the date table' }
      : { role: 'categorySlicer', confidence: 'high', why: 'slicer bound to a non-date column' };
  }

  if (visualType === 'cardVisual' || visualType === 'card' || visualType === 'multiRowCard') {
    // A card given a quarter of the page with one measure is a hero, not a KPI strip.
    const narrow = position.width <= gridWidth(5);
    if (narrow && measures.length <= 1 && position.height >= 200) {
      return { role: 'heroMetric', confidence: 'medium', why: 'a tall, narrow card holding one measure' };
    }
    return { role: 'kpiRow', confidence: 'high', why: `card holding ${measures.length || 'several'} measures` };
  }

  if (visualType === 'scatterChart') {
    return { role: 'scatter', confidence: 'high', why: 'scatter plots two measures against each other' };
  }

  if (visualType === 'pivotTable' || visualType === 'matrix') {
    return { role: 'matrix', confidence: 'high', why: 'a matrix crosses two categories' };
  }

  if (visualType === 'tableEx') {
    return { role: 'detailTable', confidence: 'high', why: 'a table shows row-level detail' };
  }

  if (visualType === 'pieChart' || visualType === 'donutChart') {
    return { role: 'composition', confidence: 'high', why: 'a donut or pie shows share of total' };
  }

  const isLine = ['lineChart', 'areaChart', 'stackedAreaChart'].includes(visualType);
  if (isLine || boundToDate) {
    return boundToDate
      ? { role: 'trend', confidence: 'high', why: 'plotted against the date table' }
      : { role: 'trend', confidence: 'low', why: 'a line chart, though not bound to a date column' };
  }

  if (visualType === 'barChart' || visualType === 'clusteredBarChart' || visualType === 'stackedBarChart') {
    return { role: 'breakdown', confidence: 'high', why: 'a ranked bar chart by category' };
  }

  if (visualType.toLowerCase().includes('column')) {
    return { role: 'comparison', confidence: 'medium', why: 'a column chart comparing categories' };
  }

  return { role: 'breakdown', confidence: 'low', why: `no rule for '${visualType}'; treated as a breakdown` };
}

function nearest(value: number, candidates: number[]): number {
  return candidates.reduce((best, c) => (Math.abs(c - value) < Math.abs(best - value) ? c : best), candidates[0]);
}

const COLUMN_X = Array.from({ length: 12 }, (_, i) => gridX(i + 1));
const COLUMN_W = Array.from({ length: 12 }, (_, i) => gridWidth(i + 1));

/** Snap a hand-drawn position onto the 12-column grid without changing its shape. */
export function snapToGrid(p: Position): { position: Position; drift: number } {
  let x = nearest(p.x, COLUMN_X);
  let width = nearest(p.width, COLUMN_W);
  if (x + width > CANVAS_RIGHT) {
    // Prefer keeping the left edge; narrow the visual until it fits.
    width = nearest(CANVAS_RIGHT - x, COLUMN_W.filter((w) => x + w <= CANVAS_RIGHT)) || COLUMN_W[0];
  }

  const round8 = (n: number) => Math.max(0, Math.round(n / 8) * 8);
  let y = round8(p.y);
  let height = round8(p.height);
  if (y + height > CANVAS_BOTTOM) height = Math.max(8, CANVAS_BOTTOM - y);

  const drift = Math.max(Math.abs(x - p.x), Math.abs(y - p.y), Math.abs(width - p.width), Math.abs(height - p.height));
  return { position: { ...p, x, y, width, height }, drift: Math.round(drift * 10) / 10 };
}

export interface HarvestedPage {
  blueprint: Blueprint;
  sourcePage: string;
  /** Visuals left out, with the reason - branding, or nothing to infer from. */
  dropped: { visual: string; reason: string }[];
  /** How far snapping moved anything, in pixels. */
  maxDrift: number;
  warnings: string[];
}

export interface HarvestLayoutOptions {
  /** Snap positions onto the grid. On by default; turn it off to keep a layout byte-faithful. */
  snap?: boolean;
  /** Prefix for generated blueprint names. Defaults to the report folder name. */
  namePrefix?: string;
  /** Only harvest this page. */
  pageFolder?: string;
}

export async function harvestLayout(
  reportPath: string,
  options: HarvestLayoutOptions = {},
): Promise<HarvestedPage[]> {
  const snap = options.snap !== false;
  const report = await readReport(reportPath);

  // Which tables are date tables? Read from the model if it is reachable, otherwise guess by name so
  // harvesting still works against a report whose model is not on this machine.
  const dateTables = new Set<string>();
  if (report.binding.kind === 'byPath') {
    try {
      const { readSemanticModel, classify } = await import('./tmdl.js');
      const model = await readSemanticModel(path.resolve(reportPath, report.binding.value));
      const inv = classify(model);
      if (inv.dateTable) dateTables.add(inv.dateTable);
    } catch {
      // Fall through to the name heuristic.
    }
  }
  if (dateTables.size === 0) {
    for (const page of report.pages) {
      for (const v of page.visuals) {
        for (const fields of Object.values(v.bindings)) {
          for (const f of fields) {
            if (/^(date|calendar|dim.?date|dates|time)$/i.test(f.table)) dateTables.add(f.table);
          }
        }
      }
    }
  }

  const prefix = options.namePrefix ?? path.basename(reportPath).replace(/\.Report$/i, '').trim();
  const out: HarvestedPage[] = [];

  for (const page of report.pages) {
    if (options.pageFolder && page.folder !== options.pageFolder && page.displayName !== options.pageFolder) {
      continue;
    }

    const dropped: HarvestedPage['dropped'] = [];
    const warnings: string[] = [];
    const slots: Slot[] = [];
    const seenRoles = new Map<SlotRole, number>();
    let maxDrift = 0;

    if (page.width !== 1280 || page.height !== 720) {
      warnings.push(
        `Source page is ${page.width}x${page.height}; slots are kept as-is and may not fit a 1280x720 canvas.`,
      );
    }

    for (const v of [...page.visuals].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)) {
      if (DECORATION.has(v.visualType)) {
        dropped.push({ visual: v.folder, reason: `${v.visualType} is branding, not layout` });
        continue;
      }
      if (v.position.width <= 0 || v.position.height <= 0) {
        dropped.push({ visual: v.folder, reason: 'zero-sized' });
        continue;
      }

      const inferred = inferRole(v.visualType, v.bindings, v.position, dateTables);
      const { position, drift } = snap ? snapToGrid(v.position) : { position: v.position, drift: 0 };
      maxDrift = Math.max(maxDrift, drift);

      // A role can only be planned once per page, so later duplicates keep the geometry but are
      // marked optional - the caller can still fill them by hand.
      const count = (seenRoles.get(inferred.role) ?? 0) + 1;
      seenRoles.set(inferred.role, count);
      const slotName = count === 1 ? v.folder : `${v.folder}`;

      slots.push({
        slot: slotName,
        role: inferred.role,
        visualType: v.visualType,
        position,
        purpose: `${inferred.why} (harvested, ${inferred.confidence} confidence)`,
        optional: count > 1 || inferred.confidence === 'low',
      });

      if (inferred.confidence === 'low') {
        warnings.push(`'${v.folder}': ${inferred.why}. Check the role before relying on it.`);
      }
      if (count > 1) {
        warnings.push(`'${v.folder}' is the ${count}th ${inferred.role} on this page; marked optional.`);
      }
    }

    if (snap) {
      for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
          const a = slots[i].position;
          const b = slots[j].position;
          const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
          const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
          if (ox > 1 && oy > 1) {
            warnings.push(`Snapping made '${slots[i].slot}' overlap '${slots[j].slot}' by ${Math.round(ox)}x${Math.round(oy)}px.`);
          }
        }
      }
      if (maxDrift > 40) {
        warnings.push(`Snapping moved something by ${maxDrift}px. The source layout is far off the grid.`);
      }
    }

    const safeName = `${prefix}-${page.displayName}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    out.push({
      sourcePage: page.displayName,
      dropped,
      maxDrift,
      warnings,
      blueprint: {
        name: safeName,
        description: `Harvested from '${page.displayName}' in ${path.basename(reportPath)} - ${slots.length} slots.`,
        useWhen: 'A layout lifted from an existing report. Check the inferred roles before relying on it.',
        slots,
      },
    });
  }

  return out;
}

// ---------------------------------------------------------------------------------------------
// Template library
// ---------------------------------------------------------------------------------------------

export interface TemplateFile {
  blueprint: Blueprint;
  source?: string;
  harvestedAt?: string;
}

export async function saveTemplate(dir: string, blueprint: Blueprint, source?: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${blueprint.name}.json`);
  const payload: TemplateFile = {
    blueprint,
    // Only the report folder name. A template is meant to be shared, and an absolute path carries a
    // username and a directory layout that have nothing to do with the layout being described.
    source: source ? path.basename(source) : undefined,
    harvestedAt: new Date().toISOString(),
  };
  await fs.writeFile(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return file;
}

export async function loadTemplates(dir: string): Promise<{ loaded: Blueprint[]; errors: string[] }> {
  const loaded: Blueprint[] = [];
  const errors: string[] = [];

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { loaded, errors };
  }

  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, entry), 'utf8')) as TemplateFile;
      const bp = raw.blueprint;
      if (!bp?.name || !Array.isArray(bp.slots) || bp.slots.length === 0) {
        errors.push(`${entry}: not a template (needs blueprint.name and a non-empty slots array)`);
        continue;
      }
      loaded.push(bp);
    } catch (err: any) {
      errors.push(`${entry}: ${err.message}`);
    }
  }

  return { loaded, errors };
}
