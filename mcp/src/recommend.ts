/**
 * Dashboard recommendation.
 *
 * Given a semantic model, work out which layouts it can actually fill and what to put in each slot,
 * then hand back arguments that can be passed straight to apply_blueprint.
 *
 * The scoring is deliberately blunt: a layout scores on how much of it the model can fill, and loses
 * points for slots it would leave empty. That is the honest signal - a template full of gaps is worse
 * than a smaller one that is complete, however impressive the big one looks in a gallery.
 *
 * What this cannot do is judge whether the result answers anyone's question. It has no access to the
 * data, so cardinality is unchecked and "important" is inferred from names and format strings. It is
 * a starting point to edit, not a verdict.
 */

import { BLUEPRINTS, Blueprint, SlotRole } from './blueprints.js';
import { FieldRef } from './pbir.js';
import { ModelInventory, SemanticModel, classify } from './tmdl.js';

export interface Recommendation {
  blueprint: string;
  description: string;
  score: number;
  fillable: number;
  total: number;
  /** Slots this model cannot fill, with the reason. */
  gaps: { slot: string; reason: string }[];
  reasons: string[];
  /** Ready to pass to apply_blueprint. */
  applyArguments: Record<string, unknown>;
}

export interface RecommendationResult {
  title: string;
  inventory: {
    dateTable?: string;
    dateColumn?: string;
    measures: number;
    categories: number;
  };
  assignment: Record<string, unknown>;
  recommendations: Recommendation[];
  notes: string[];
}

/** Which pieces of the field assignment a role consumes. */
const NEEDS: Record<SlotRole, (keyof Assignment)[]> = {
  title: [],
  dateSlicer: ['dateField'],
  categorySlicer: ['primaryCategory'],
  kpiRow: ['kpiMeasures'],
  heroMetric: ['kpiMeasures'],
  trend: ['dateField', 'kpiMeasures'],
  breakdown: ['primaryCategory', 'kpiMeasures'],
  comparison: ['primaryCategory', 'kpiMeasures'],
  composition: ['secondaryCategory', 'kpiMeasures'],
  matrix: ['primaryCategory', 'secondaryCategory', 'kpiMeasures'],
  detailTable: ['detailFields'],
  scatter: ['primaryCategory', 'twoMeasures'],
};

interface Assignment {
  kpiMeasures: FieldRef[];
  dateField?: FieldRef;
  primaryCategory?: FieldRef;
  secondaryCategory?: FieldRef;
  detailFields?: FieldRef[];
  twoMeasures?: boolean;
}

function buildAssignment(inv: ModelInventory): Assignment {
  const kpiMeasures: FieldRef[] = inv.kpiCandidates
    .slice(0, 4)
    .map((k) => ({ table: k.table, field: k.measure, kind: 'Measure' as const }));

  const categories = inv.categoryCandidates.map((c) => ({
    table: c.table,
    field: c.column,
    kind: 'Column' as const,
  }));

  const dateField =
    inv.dateTable && inv.dateColumn
      ? { table: inv.dateTable, field: inv.dateColumn, kind: 'Column' as const }
      : undefined;

  const primaryCategory = categories[0];
  // A second category only earns its place if it is genuinely a different column.
  const secondaryCategory = categories.find(
    (c) => !primaryCategory || c.table !== primaryCategory.table || c.field !== primaryCategory.field,
  );

  const detailFields: FieldRef[] = [];
  if (primaryCategory) detailFields.push(primaryCategory);
  detailFields.push(...kpiMeasures.slice(0, 2));

  return {
    kpiMeasures,
    dateField,
    primaryCategory,
    secondaryCategory,
    detailFields: detailFields.length >= 2 ? detailFields : undefined,
    twoMeasures: kpiMeasures.length >= 2,
  };
}

function missingFor(role: SlotRole, a: Assignment): string | undefined {
  for (const need of NEEDS[role] ?? []) {
    if (need === 'kpiMeasures' && a.kpiMeasures.length === 0) return 'the model has no usable measure';
    if (need === 'twoMeasures' && !a.twoMeasures) return 'a scatter needs two measures and the model has one';
    if (need === 'dateField' && !a.dateField) return 'the model has no date table';
    if (need === 'primaryCategory' && !a.primaryCategory) return 'the model has no usable category column';
    if (need === 'secondaryCategory' && !a.secondaryCategory) return 'the model has only one category column';
    if (need === 'detailFields' && !a.detailFields) return 'not enough fields for a detail table';
  }
  return undefined;
}

function scoreBlueprint(bp: Blueprint, a: Assignment): Recommendation {
  const gaps: Recommendation['gaps'] = [];
  const filledRoles = new Set<string>();
  let fillable = 0;

  for (const slot of bp.slots) {
    // Mirror applyBlueprint: an optional slot repeating a role it has already placed is skipped,
    // because one field assignment would put the same chart there twice. Counting it as fillable
    // would report a layout as complete that arrives two-thirds empty - which is exactly what a
    // harvested 12-slot page with seven trend slots did.
    if (slot.optional && filledRoles.has(slot.role)) {
      gaps.push({ slot: slot.slot, reason: `a ${slot.role} is already placed; this would be a duplicate` });
      continue;
    }

    const missing = missingFor(slot.role, a);
    if (missing) {
      gaps.push({ slot: slot.slot, reason: missing });
      continue;
    }

    filledRoles.add(slot.role);
    fillable++;
  }

  const total = bp.slots.length;
  // Completeness first, then size as a tie-break: a full seven-slot page beats a full three-slot one,
  // but a three-slot page with no gaps beats a seven-slot page with four.
  const completeness = total === 0 ? 0 : fillable / total;
  const requiredGaps = bp.slots.filter(
    (s) => !s.optional && gaps.some((g) => g.slot === s.slot),
  ).length;
  const score = Math.round((completeness * 100 - requiredGaps * 15 + Math.min(fillable, 8)) * 10) / 10;

  const reasons: string[] = [];
  if (gaps.length === 0) reasons.push('every slot can be filled from this model');
  else reasons.push(`${fillable} of ${total} slots fillable`);
  if (requiredGaps > 0) reasons.push(`${requiredGaps} non-optional slot(s) would be left empty`);
  if (a.dateField && bp.slots.some((s) => s.role === 'trend')) reasons.push('the model has a date table and this layout uses it');

  const applyArguments: Record<string, unknown> = {
    blueprint: bp.name,
    kpiMeasures: a.kpiMeasures,
  };
  if (a.dateField) applyArguments.dateField = a.dateField;
  if (a.primaryCategory) applyArguments.primaryCategory = a.primaryCategory;
  if (a.secondaryCategory) applyArguments.secondaryCategory = a.secondaryCategory;
  if (a.detailFields) applyArguments.detailFields = a.detailFields;

  return {
    blueprint: bp.name,
    description: bp.description,
    score,
    fillable,
    total,
    gaps,
    reasons,
    applyArguments,
  };
}

export function recommend(model: SemanticModel, title?: string, limit = 3): RecommendationResult {
  const inv = classify(model);
  const assignment = buildAssignment(inv);

  const recommendations = Object.values(BLUEPRINTS)
    .map((bp) => scoreBlueprint(bp, assignment))
    .sort((a, b) => b.score - a.score || a.blueprint.localeCompare(b.blueprint))
    .slice(0, limit);

  const notes = [...inv.notes];
  if (!assignment.dateField) {
    notes.push('No date table, so every time-based slot is skipped. Adding one changes the ranking most.');
  }
  if (assignment.kpiMeasures.length < 2) {
    notes.push('Fewer than two measures. Scatter layouts and multi-measure KPI rows cannot be filled.');
  }
  if (!assignment.secondaryCategory) {
    notes.push('Only one category column, so composition and matrix slots stay empty.');
  }
  notes.push('Slot assignment comes from names and format strings, not from the data. Check the picks.');

  return {
    title: title ?? 'Dashboard',
    inventory: {
      dateTable: inv.dateTable,
      dateColumn: inv.dateColumn,
      measures: inv.kpiCandidates.length,
      categories: inv.categoryCandidates.length,
    },
    assignment: {
      kpiMeasures: assignment.kpiMeasures,
      dateField: assignment.dateField,
      primaryCategory: assignment.primaryCategory,
      secondaryCategory: assignment.secondaryCategory,
      detailFields: assignment.detailFields,
    },
    recommendations,
    notes,
  };
}
