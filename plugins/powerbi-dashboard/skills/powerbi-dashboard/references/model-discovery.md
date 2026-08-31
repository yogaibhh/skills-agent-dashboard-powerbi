# Model discovery and field classification

Goal: end this step with a **field inventory** you can hand to a blueprint. Everything the dashboard
shows is chosen here; getting this wrong produces a report that renders but says nothing.

## 1. Read the model

Pick whichever source is available, in this order of preference.

### A. Power BI Modeling MCP server (best - live model, real metadata)

If `powerbi-modeling-mcp` tools are available:

1. Connect: `connection_operations` (Power BI Desktop) or the `ConnectToFabric` prompt (workspace model).
2. `table_operations` list -> tables.
3. `measure_operations` list -> measures, their DAX, their `displayFolder` and `formatString`.
4. `column_operations` list -> columns, data types, `isHidden`, `dataCategory`.
5. `relationship_operations` list -> which table is the fact table (the many side of most relationships).

Live discovery also lets you **verify cardinality** before choosing a category column, which is the
main thing static file reading cannot do. See section 3.

### B. TMDL files in a PBIP folder

Read `<Model>.SemanticModel/definition/tables/*.tmdl`. Useful patterns:

```
table 'Sales'            -> table name
    measure 'Total Sales' -> measure name (quoted when it contains spaces)
    column 'Order Date'   -> column name
        dataType: dateTime
        isHidden               -> skip hidden columns
        summarizeBy: sum
    isHidden                   -> skip hidden tables entirely
```

`definition/relationships.tmdl` gives `fromTable` / `toTable`; the table appearing most often as
`fromTable` is almost always the fact table.

### C. The report's existing `definition.pbir`

If you are extending an existing report, `definition.pbir` names the model. Resolve `byPath` to the
local folder and read its TMDL; for `byConnection`, use the MCP server or `fabric-cli` to fetch it.

## 2. Classify what you found

Fill in this table before writing any JSON:

| Slot | What to look for | Fallback if missing |
| --- | --- | --- |
| Fact table | Most rows; the `from` side of most relationships | The table holding the measures |
| Date table | `dataCategory: Time` on the table, or a table named Date/Calendar/Dim Date with a contiguous date column | Omit the date slicer and any time-series visual |
| Date column | The date-typed key column of the date table (not the year/month text columns) | As above |
| KPI measures | 2-4 headline measures | Create a `COUNTROWS` measure, or use an aggregated column |
| Category columns | 2-5 low-cardinality text columns from dimension tables | Use whatever text column has the fewest distinct values |
| Detail columns | 4-8 columns a user would want to see as rows | Skip the detail table |

### Choosing KPI measures

Rank measures by these signals, highest first:

1. Named like a headline total: `Total *`, `* Amount`, `* Revenue`, `* Sales`, `# *`, `* Count`.
2. Has a currency, percentage or thousands `formatString` - formatted measures are usually the ones
   built for display.
3. Sits in the root of the fact table rather than in a nested `displayFolder` such as
   `Internal` / `Helpers` / `Base`.
4. Simple aggregation DAX (`SUM`, `COUNTROWS`, `DISTINCTCOUNT`) rather than a ratio over another
   measure - ratios usually belong next to the thing they measure, not on the KPI row.

Exclude: measures whose names start with `_`, measures in folders named `Internal`/`Hidden`/`Debug`,
and `isHidden` measures. Cap the KPI row at 4.

### Choosing category columns

A column is a good category when **all** of these hold:

- It is a text column on a dimension table (not the fact table's own key columns).
- It is not hidden and not the relationship key.
- Its distinct count is roughly 3-30.

Verify the count instead of guessing - see section 3.

Reject as categories: GUID/ID columns, email/address/description/note columns, anything named `*Key`,
`*ID`, `*Code` (unless it is a short business code), and any column whose distinct count exceeds ~50
without a Top-N filter.

## 3. Verify cardinality with DAX

When the Modeling MCP server or a DAX endpoint is available, run this before committing to a category.
It is the difference between a readable bar chart and a solid block of 5,000 bars.

```dax
EVALUATE
ROW(
    "DistinctValues", DISTINCTCOUNT('Product'[Category]),
    "BlankValues", COUNTROWS( FILTER( VALUES('Product'[Category]), ISBLANK('Product'[Category]) ) )
)
```

Interpretation:

| Distinct values | Verdict |
| --- | --- |
| 2-7 | Great - donut, stacked bar, or legend/series field |
| 8-30 | Good - sorted bar chart, no filter needed |
| 31-200 | Usable only with a Top-N filter and sorting |
| 200+ | Not a category. Use it in a detail table or as a slicer with search. |

Sanity-check a KPI measure the same way before putting it on a card - a measure that evaluates to
blank at the grand-total grain will render an empty card:

```dax
EVALUATE ROW("Value", [Total Sales])
```

## 4. Record the inventory

Write the inventory down explicitly before generating - in your reply to the user, or in a scratch
file. It is the contract the rest of the build reads from:

```yaml
title: Sales Overview
factTable: Sales
dateTable: Date
dateColumn: Date
kpiMeasures:            # max 4, in display order
  - { table: Sales, measure: Total Sales }
  - { table: Sales, measure: Total Orders }
  - { table: Sales, measure: Avg Order Value }
  - { table: Sales, measure: Margin % }
categories:
  - { table: Product,  column: Category, distinct: 8 }
  - { table: Customer, column: Segment,  distinct: 3 }
  - { table: Store,    column: Country,  distinct: 24 }   # needs Top-N
detailColumns:
  - { table: Product, column: Product Name }
  - { table: Sales,   measure: Total Sales }
```

Every `Entity` / `Property` pair you write into a `visual.json` must come from this inventory. If it is
not in the inventory, it does not go in the report.
