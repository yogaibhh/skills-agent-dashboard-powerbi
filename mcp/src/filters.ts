/**
 * Visual-level filters.
 *
 * Top-N is the honest answer to a category with thousands of members: a bar chart of 3,768 products
 * is a solid block whatever you do to the axis. The catalog previously said "do not hand-write this,
 * harvest it" - so it was harvested. The shape below is taken from eleven real TopN filters found
 * across four public reports, and it is more involved than it looks: the filter is a subquery that
 * selects the category, orders it by the measure, takes the top N, and then constrains the visual to
 * the members that subquery returned.
 *
 * `filterConfig` sits at the **root** of visual.json, beside `name` and `position` - not inside
 * `visual`. Every one of the eleven was at the root.
 */

import { FieldRef, newPbirName } from './pbir.js';

/** Power BI encodes sort direction numerically. Every observed TopN used 2. */
const DIRECTION = { Ascending: 1, Descending: 2 } as const;

export interface TopNOptions {
  /** The column being limited - the visual's category. */
  category: FieldRef;
  /** The measure that decides the ranking. */
  measure: FieldRef;
  /** How many members to keep. */
  top: number;
  direction?: keyof typeof DIRECTION;
  /** Reuse an existing filter name when replacing one. */
  name?: string;
}

export function buildTopNFilter(options: TopNOptions): Record<string, unknown> {
  const { category, measure, top } = options;
  const direction = DIRECTION[options.direction ?? 'Descending'];

  if (!Number.isInteger(top) || top < 1) {
    throw new Error(`topN must be a positive whole number, got ${top}.`);
  }
  if (category.kind !== 'Column') {
    throw new Error('Top-N limits a category column; pass a Column, not a Measure.');
  }
  if (measure.kind !== 'Measure') {
    throw new Error('Top-N ranks by a measure; pass a Measure, not a Column.');
  }

  // Two aliases when the category and the measure live on different tables, which is the shape every
  // harvested example used. When they share a table one alias covers both - inferred rather than
  // observed, since no harvested example ranked a same-table category by a measure.
  const sameTable = category.table === measure.table;
  const catAlias = 'c';
  const measureAlias = sameTable ? 'c' : 'm';

  const from: Record<string, unknown>[] = [{ Name: catAlias, Entity: category.table, Type: 0 }];
  if (!sameTable) from.push({ Name: measureAlias, Entity: measure.table, Type: 0 });

  const subquery = {
    Version: 2,
    From: from,
    Select: [
      {
        Column: { Expression: { SourceRef: { Source: catAlias } }, Property: category.field },
        Name: 'field',
      },
    ],
    OrderBy: [
      {
        Direction: direction,
        Expression: {
          Measure: { Expression: { SourceRef: { Source: measureAlias } }, Property: measure.field },
        },
      },
    ],
    Top: top,
  };

  return {
    name: options.name ?? newPbirName(),
    field: {
      Column: { Expression: { SourceRef: { Entity: category.table } }, Property: category.field },
    },
    type: 'TopN',
    filter: {
      Version: 2,
      From: [
        { Name: 'subquery', Expression: { Subquery: { Query: subquery } }, Type: 2 },
        { Name: catAlias, Entity: category.table, Type: 0 },
      ],
      // Constrain the visual to whatever the subquery returned.
      Where: [
        {
          Condition: {
            In: {
              Expressions: [
                { Column: { Expression: { SourceRef: { Source: catAlias } }, Property: category.field } },
              ],
              Table: { SourceRef: { Source: 'subquery' } },
            },
          },
        },
      ],
    },
  };
}
