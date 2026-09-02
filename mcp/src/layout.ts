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

/**
 * Branding and navigation chrome, not layout. Buttons matter here: they have no bindings, so role
 * inference falls through to 'breakdown' and the generator dutifully turns a Back button into a bar
 * chart.
 */
const DECORATION = new Set(['image', 'shape', 'basicShape', 'actionButton', 'blank']);

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

/**
 * Rescales a layout from its source canvas onto the target one.
 *
 * Most real reports are authored at 1920x1080, not the 1280x720 the generator uses. Snapping those
 * coordinates directly does not adapt the layout, it amputates it: a visual at x=1500 gets clamped to
 * the right margin. Scaling first preserves the design, and because 1920x1080 and 1280x720 are both
 * 16:9 the common case is an exact proportional shrink.
 */
function rescale(p: Position, sx: number, sy: number): Position {
  return {
    ...p,
    x: p.x * sx,
    y: p.y * sy,
    width: p.width * sx,
    height: p.height * sy,
  };
}

export interface HarvestLayoutOptions {
  /** Canvas to normalise onto. Defaults to the 1280x720 the blueprints use. */
  targetWidth?: number;
  targetHeight?: number;
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
  const targetWidth = options.targetWidth ?? 1280;
  const targetHeight = options.targetHeight ?? 720;
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

    const scaleX = targetWidth / page.width;
    const scaleY = targetHeight / page.height;
    const rescaled = scaleX !== 1 || scaleY !== 1;

    if (rescaled) {
      const sourceAspect = page.width / page.height;
      const targetAspect = targetWidth / targetHeight;
      const skew = Math.abs(sourceAspect - targetAspect) / targetAspect;
      warnings.push(
        `Source page is ${page.width}x${page.height}; rescaled by ${scaleX.toFixed(3)}x${scaleY.toFixed(3)} onto ${targetWidth}x${targetHeight}.`,
      );
      if (skew > 0.05) {
        warnings.push(
          `Source aspect ratio differs from the target by ${Math.round(skew * 100)}%, so proportions are stretched, not just scaled.`,
        );
      }
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

      const scaledPosition = rescaled ? rescale(v.position, scaleX, scaleY) : v.position;
      const inferred = inferRole(v.visualType, v.bindings, scaledPosition, dateTables);
      const { position, drift } = snap ? snapToGrid(scaledPosition) : { position: scaledPosition, drift: 0 };
      maxDrift = Math.max(maxDrift, drift);

      // A role can only be planned once per page, so later duplicates keep the geometry but are
      // marked optional - the caller can still fill them by hand.
      const count = (seenRoles.get(inferred.role) ?? 0) + 1;
      seenRoles.set(inferred.role, count);
      // Real reports name visual folders with the internal hex token, which makes an unreadable
      // template. Name by what the slot is for instead.
      const slotName = count === 1 ? inferred.role : `${inferred.role}${count}`;

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
      // Half a column is 52px, so any layout not already on this grid drifts up to that much by
      // definition. Only warn past it, or the warning fires on every healthy harvest.
      if (maxDrift > 60) {
        warnings.push(
          `Snapping moved something by ${maxDrift}px, more than half a column (52px). Something was clamped at a margin - check the result.`,
        );
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

export interface Attribution {
  /** Where the layout came from, e.g. 'microsoft/fabric-toolbox'. */
  repository?: string;
  /** SPDX id of the source licence, e.g. 'MIT'. */
  license?: string;
  url?: string;
}

export interface TemplateFile {
  blueprint: Blueprint;
  source?: string;
  attribution?: Attribution;
  harvestedAt?: string;
}

export async function saveTemplate(
  dir: string,
  blueprint: Blueprint,
  source?: string,
  attribution?: Attribution,
): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${blueprint.name}.json`);
  const payload: TemplateFile = {
    blueprint,
    // Only the report folder name. A template is meant to be shared, and an absolute path carries a
    // username and a directory layout that have nothing to do with the layout being described.
    source: source ? path.basename(source) : undefined,
    // Layout geometry is thin on original expression, but a template lifted from someone else's
    // work should still say whose it was and under what licence.
    attribution,
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
