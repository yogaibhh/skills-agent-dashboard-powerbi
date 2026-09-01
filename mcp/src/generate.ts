/**
 * Blueprint application: turn a field assignment into a full page of bound visuals in one call.
 *
 * A slot the assignment cannot fill is skipped with a reason rather than emitted empty - an unbound
 * visual is worse than a missing one, because it renders as a blank box the user has to diagnose.
 */

import { Bindings, FieldRef } from './pbir.js';
import { Blueprint, Slot, getBlueprint } from './blueprints.js';
import { writeVisual } from './visuals.js';

export interface FieldAssignment {
  title: string;
  /** Up to four headline measures for the KPI row. */
  kpiMeasures: FieldRef[];
  /** Date column, from the model's date table. Without it, time-based slots are skipped. */
  dateField?: FieldRef;
  /** The measure charts plot. Defaults to the first KPI measure. */
  primaryMeasure?: FieldRef;
  primaryCategory?: FieldRef;
  secondaryCategory?: FieldRef;
  /** Columns and measures for the detail table, in display order. */
  detailFields?: FieldRef[];
}

export interface AppliedSlot {
  slot: string;
  visualType: string;
  visualFolder: string;
  bindings: Bindings;
}

export interface SkippedSlot {
  slot: string;
  reason: string;
}

export interface ApplyBlueprintResult {
  blueprint: string;
  pageFolder: string;
  applied: AppliedSlot[];
  skipped: SkippedSlot[];
}

interface Plan {
  bindings?: Bindings;
  text?: string;
  title?: string | null;
  slicerMode?: 'Between' | 'Dropdown' | 'Basic';
  sortBy?: { table: string; field: string; direction: 'Descending' };
  skip?: string;
}

function planSlot(slot: Slot, a: FieldAssignment): Plan {
  const measure = a.primaryMeasure ?? a.kpiMeasures[0];

  switch (slot.role) {
    case 'title':
      return { text: a.title, title: null };

    case 'dateSlicer':
      if (!a.dateField) return { skip: 'no dateField supplied - the model has no usable date column' };
      return { bindings: { Values: [a.dateField] }, slicerMode: 'Between', title: null };

    case 'categorySlicer':
      if (!a.primaryCategory) return { skip: 'no primaryCategory supplied' };
      return { bindings: { Values: [a.primaryCategory] }, slicerMode: 'Dropdown', title: null };

    case 'kpiRow':
      if (a.kpiMeasures.length === 0) return { skip: 'no kpiMeasures supplied' };
      return { bindings: { Data: a.kpiMeasures.slice(0, 4) }, title: null };

    case 'trend':
      if (!a.dateField) return { skip: 'no dateField supplied' };
      if (!measure) return { skip: 'no measure available' };
      return {
        bindings: { Category: [a.dateField], Y: [measure] },
        title: `${measure.field} over time`,
      };

    case 'breakdown':
      if (!a.primaryCategory) return { skip: 'no primaryCategory supplied' };
      if (!measure) return { skip: 'no measure available' };
      return {
        bindings: { Category: [a.primaryCategory], Y: [measure] },
        title: `${measure.field} by ${a.primaryCategory.field}`,
        sortBy: { table: measure.table, field: measure.field, direction: 'Descending' },
      };

    case 'comparison': {
      const axis = a.secondaryCategory ?? a.primaryCategory;
      if (!axis) return { skip: 'no category supplied' };
      if (!measure) return { skip: 'no measure available' };
      const bindings: Bindings = { Category: [axis], Y: [measure] };
      // Only add a series when there is a second, different category to split by.
      if (a.secondaryCategory && a.primaryCategory && a.primaryCategory !== axis) {
        bindings.Series = [a.primaryCategory];
      }
      return { bindings, title: `${measure.field} by ${axis.field}` };
    }

    case 'composition':
      if (!a.secondaryCategory) return { skip: 'no secondaryCategory supplied' };
      if (!measure) return { skip: 'no measure available' };
      return {
        bindings: { Category: [a.secondaryCategory], Y: [measure] },
        title: `${measure.field} share by ${a.secondaryCategory.field}`,
      };

    case 'matrix': {
      if (!a.primaryCategory || !a.secondaryCategory) {
        return { skip: 'a matrix needs both primaryCategory and secondaryCategory' };
      }
      if (a.kpiMeasures.length === 0) return { skip: 'no measures available' };
      return {
        bindings: {
          Rows: [a.primaryCategory],
          Columns: [a.secondaryCategory],
          Values: a.kpiMeasures.slice(0, 2),
        },
      };
    }

    case 'detailTable':
      if (!a.detailFields || a.detailFields.length === 0) return { skip: 'no detailFields supplied' };
      return { bindings: { Values: a.detailFields } };

    default:
      return { skip: `no rule for slot role '${slot.role}'` };
  }
}

export async function applyBlueprint(
  reportPath: string,
  pageFolder: string,
  blueprintName: string,
  assignment: FieldAssignment,
  overwrite = false,
): Promise<ApplyBlueprintResult> {
  const blueprint: Blueprint = getBlueprint(blueprintName);
  const applied: AppliedSlot[] = [];
  const skipped: SkippedSlot[] = [];

  for (const slot of blueprint.slots) {
    const plan = planSlot(slot, assignment);

    if (plan.skip) {
      if (!slot.optional && slot.role !== 'title') {
        // A required slot that cannot be filled is still skipped, but the caller needs to know the
        // page will not match the blueprint.
        skipped.push({ slot: slot.slot, reason: `${plan.skip} (this slot is not optional)` });
      } else {
        skipped.push({ slot: slot.slot, reason: plan.skip });
      }
      continue;
    }

    await writeVisual({
      reportPath,
      pageFolder,
      visualFolder: slot.slot,
      visualType: slot.visualType,
      position: slot.position,
      bindings: plan.bindings,
      text: plan.text,
      title: plan.title,
      slicerMode: plan.slicerMode,
      sortBy: plan.sortBy,
      overwrite,
    });

    applied.push({
      slot: slot.slot,
      visualType: slot.visualType,
      visualFolder: slot.slot,
      bindings: plan.bindings ?? {},
    });
  }

  return { blueprint: blueprint.name, pageFolder, applied, skipped };
}
