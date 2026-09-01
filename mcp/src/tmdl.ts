/**
 * Minimal TMDL reader.
 *
 * Enough to answer the two questions report generation actually asks: does this field exist, and
 * which fields are worth putting on a dashboard. It is not a TMDL parser - it reads the declarations
 * and their immediate properties, and ignores expressions.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface ModelColumn {
  name: string;
  dataType?: string;
  hidden: boolean;
}

export interface ModelMeasure {
  name: string;
  hidden: boolean;
  displayFolder?: string;
  formatString?: string;
}

export interface ModelTable {
  name: string;
  hidden: boolean;
  dataCategory?: string;
  columns: ModelColumn[];
  measures: ModelMeasure[];
}

export interface SemanticModel {
  modelPath: string;
  tables: ModelTable[];
}

const DECL = /^(\s*)(table|column|measure)\s+('[^']+'|[^\s=]+)\s*(=|$)/;
const PROP = /^\s*(dataType|isHidden|displayFolder|formatString|dataCategory)\s*:?\s*(.*)$/;

function unquote(value: string): string {
  return value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : value;
}

export async function readSemanticModel(modelPath: string): Promise<SemanticModel> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.toLowerCase().endsWith('.tmdl')) files.push(full);
    }
  }

  try {
    await walk(modelPath);
  } catch {
    throw new Error(`Semantic model path not readable: ${modelPath}`);
  }

  if (files.length === 0) {
    throw new Error(`No .tmdl files found under ${modelPath}. Is this a *.SemanticModel folder?`);
  }

  const tables = new Map<string, ModelTable>();

  for (const file of files.sort()) {
    const text = await fs.readFile(file, 'utf8');
    let table: ModelTable | undefined;
    // The object a property line belongs to: whichever declaration we saw most recently.
    let target: { kind: 'table' | 'column' | 'measure'; ref: any } | undefined;

    for (const line of text.split(/\r?\n/)) {
      const decl = DECL.exec(line);
      if (decl) {
        const [, , kind, rawName] = decl;
        const name = unquote(rawName);

        if (kind === 'table') {
          table = tables.get(name);
          if (!table) {
            table = { name, hidden: false, columns: [], measures: [] };
            tables.set(name, table);
          }
          target = { kind: 'table', ref: table };
        } else if (table) {
          if (kind === 'column') {
            const column: ModelColumn = { name, hidden: false };
            table.columns.push(column);
            target = { kind: 'column', ref: column };
          } else {
            const measure: ModelMeasure = { name, hidden: false };
            table.measures.push(measure);
            target = { kind: 'measure', ref: measure };
          }
        }
        continue;
      }

      if (!target) continue;
      const prop = PROP.exec(line);
      if (!prop) continue;

      const [, key, rawValue] = prop;
      const value = rawValue.trim().replace(/^['"]|['"]$/g, '');

      switch (key) {
        case 'isHidden':
          // `isHidden` on its own line means true; `isHidden: false` means false.
          target.ref.hidden = value === '' || value.toLowerCase() === 'true';
          break;
        case 'dataType':
          if (target.kind === 'column') target.ref.dataType = value;
          break;
        case 'dataCategory':
          // Only meaningful on a table here: dataCategory: Time is how a date table declares itself.
          if (target.kind === 'table') target.ref.dataCategory = value;
          break;
        case 'displayFolder':
          if (target.kind === 'measure') target.ref.displayFolder = value;
          break;
        case 'formatString':
          if (target.kind === 'measure') target.ref.formatString = value;
          break;
      }
    }
  }

  return { modelPath, tables: [...tables.values()] };
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

export interface ModelInventory {
  tables: ModelTable[];
  dateTable?: string;
  dateColumn?: string;
  kpiCandidates: { table: string; measure: string; reason: string }[];
  categoryCandidates: { table: string; column: string }[];
  notes: string[];
}

const DATE_TYPES = new Set(['datetime', 'date']);
const HEADLINE = /^(total|sum|count|#|avg|average|net|gross)\b|\b(amount|revenue|sales|total|count|qty|quantity|margin|profit)\b/i;
const INTERNAL_FOLDER = /^(internal|hidden|debug|helper|helpers|base|_)/i;
const BAD_CATEGORY = /(key|id|guid|code|email|address|description|notes?|comment|url|path)$/i;

/**
 * Ranks what the model offers, so the caller can pick fields without reading every table.
 * These are candidates, not decisions - cardinality still has to be checked against real data.
 */
export function classify(model: SemanticModel): ModelInventory {
  const notes: string[] = [];
  const visible = model.tables.filter((t) => !t.hidden);

  // Date table: an explicit Time data category wins; otherwise a conventional name with a date column.
  let dateTable: ModelTable | undefined = visible.find((t) => t.dataCategory === 'Time');
  if (!dateTable) {
    dateTable = visible.find(
      (t) =>
        /^(date|calendar|dim.?date|dates)$/i.test(t.name) &&
        t.columns.some((c) => DATE_TYPES.has((c.dataType ?? '').toLowerCase())),
    );
  }
  if (!dateTable) {
    dateTable = visible.find((t) => t.columns.some((c) => DATE_TYPES.has((c.dataType ?? '').toLowerCase())));
    if (dateTable) notes.push(`No conventional date table found; using '${dateTable.name}' because it has a date column.`);
  }

  const dateColumn = dateTable?.columns.find(
    (c) => !c.hidden && DATE_TYPES.has((c.dataType ?? '').toLowerCase()),
  )?.name;

  if (!dateTable) notes.push('No date table found - omit the date slicer and any time-series visual.');

  const kpiCandidates: ModelInventory['kpiCandidates'] = [];
  for (const table of visible) {
    for (const measure of table.measures) {
      if (measure.hidden) continue;
      if (measure.name.startsWith('_')) continue;
      if (measure.displayFolder && INTERNAL_FOLDER.test(measure.displayFolder)) continue;

      const reasons: string[] = [];
      if (HEADLINE.test(measure.name)) reasons.push('headline name');
      if (measure.formatString) reasons.push('has a format string');
      if (!measure.displayFolder) reasons.push('not filed away in a folder');

      kpiCandidates.push({
        table: table.name,
        measure: measure.name,
        reason: reasons.length > 0 ? reasons.join(', ') : 'visible measure',
      });
    }
  }

  // Strongest signals first, so the caller can take the top few.
  kpiCandidates.sort((a, b) => b.reason.split(',').length - a.reason.split(',').length);

  const categoryCandidates: ModelInventory['categoryCandidates'] = [];
  for (const table of visible) {
    if (dateTable && table.name === dateTable.name) continue;
    for (const column of table.columns) {
      if (column.hidden) continue;
      const type = (column.dataType ?? '').toLowerCase();
      if (type && type !== 'string') continue;
      if (BAD_CATEGORY.test(column.name)) continue;
      categoryCandidates.push({ table: table.name, column: column.name });
    }
  }

  if (kpiCandidates.length === 0) notes.push('No visible measures found - the KPI row will have nothing to show.');
  if (categoryCandidates.length === 0) notes.push('No usable category columns found - charts will have no axis.');
  notes.push('Cardinality is not checked here. Verify a category has roughly 3-30 distinct values before using it.');

  return { tables: model.tables, dateTable: dateTable?.name, dateColumn, kpiCandidates, categoryCandidates, notes };
}

/** Case-sensitive existence check, with a case-insensitive fallback for better error messages. */
export function resolveField(
  model: SemanticModel,
  table: string,
  field: string,
  kind: 'Measure' | 'Column',
): { ok: true } | { ok: false; message: string } {
  const exact = model.tables.find((t) => t.name === table);
  const loose = exact ?? model.tables.find((t) => t.name.toLowerCase() === table.toLowerCase());

  if (!loose) {
    return { ok: false, message: `Table '${table}' does not exist in the model.` };
  }
  if (!exact) {
    return { ok: false, message: `Table '${table}' differs in case from the model's '${loose.name}'.` };
  }

  const pool = kind === 'Measure' ? loose.measures.map((m) => m.name) : loose.columns.map((c) => c.name);
  if (pool.includes(field)) return { ok: true };

  const ci = pool.find((n) => n.toLowerCase() === field.toLowerCase());
  if (ci) return { ok: false, message: `${kind} '${field}' differs in case from the model's '${ci}'.` };

  return { ok: false, message: `${kind} '${field}' does not exist on table '${loose.name}'.` };
}
