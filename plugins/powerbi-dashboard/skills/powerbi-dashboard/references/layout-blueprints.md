# Layout blueprints

Every coordinate below is a literal `position` value for a `visual.json`. Copy them; do not invent
your own. Consistent geometry is most of what separates a generated dashboard from a messy one.

## The grid

Standard canvas: **1280 x 720** (`page.json` -> `width` / `height`, `displayOption: "FitToPage"`).

- Outer margin: **24 px** on all sides -> usable band is x 24..1256, y 24..696.
- 12 columns, **16 px** gutter -> column width **88 px**.

```
width(n columns)  = 104 * n - 16
x(column c)       = 24 + 104 * (c - 1)
```

| Columns | Width | | Start col | x |
| --- | --- | --- | --- | --- |
| 1 | 88 | | 1 | 24 |
| 2 | 192 | | 3 | 232 |
| 3 | 296 | | 4 | 336 |
| 4 | 400 | | 5 | 440 |
| 6 | 608 | | 7 | 648 |
| 8 | 816 | | 9 | 856 |
| 12 | 1232 | | 10 | 960 |

### Vertical bands

| Band | y | height | ends at |
| --- | --- | --- | --- |
| Header (title, slicers) | 16 | 56 | 72 |
| KPI row | 88 | 112 | 200 |
| Row A | 216 | 232 | 448 |
| Row B | 464 | 232 | 696 |
| Row A+B merged | 216 | 480 | 696 |

### z and tabOrder

`z` controls stacking, `tabOrder` keyboard order. Use these defaults so backgrounds never cover charts:

| Layer | z | tabOrder |
| --- | --- | --- |
| Background shapes | 0 | 0 |
| Charts, tables | 1000-4000 | 1000-4000 |
| KPI cards | 5000 | 5000 |
| Title, logo, slicers | 8000-9000 | 6000+ |

Give each visual a distinct `z`. Step by 1000 in the order you emit them.

---

## Blueprint: `executive-overview`

The default. KPI row, a trend, a breakdown, and detail underneath.

```
+--------------------------------------------------------------+
| Title                                        |  Date slicer   |
+--------------------------------------------------------------+
|                     KPI row (up to 4)                        |
+---------------------------------------------+----------------+
|  Trend (line, by date)                      |  Bar (top cat) |
+---------------------------------------------+----------------+
|  Detail table                               |  Donut (mix)   |
+---------------------------------------------+----------------+
```

| Slot | visualType | x | y | width | height | z |
| --- | --- | --- | --- | --- | --- | --- |
| `title` | `textbox` | 24 | 16 | 608 | 56 | 9000 |
| `dateSlicer` | `slicer` | 960 | 16 | 296 | 56 | 8000 |
| `kpiRow` | `cardVisual` | 24 | 88 | 1232 | 112 | 5000 |
| `trend` | `lineChart` | 24 | 216 | 816 | 232 | 4000 |
| `breakdown` | `barChart` | 856 | 216 | 400 | 232 | 3000 |
| `detailTable` | `tableEx` | 24 | 464 | 816 | 232 | 2000 |
| `mix` | `donutChart` | 856 | 464 | 400 | 232 | 1000 |

Bindings: `trend` = date column on Category + KPI #1 on Y. `breakdown` = category #1 on Category +
KPI #1 on Y, sorted descending, Top 10. `mix` = category #2 (must be <= 7 distinct) + KPI #1.

Drop `mix` and widen `detailTable` to 1232 when the model has only one good category column.

---

## Blueprint: `trend-analysis`

Time dominates. Use when the question is about change over time.

| Slot | visualType | x | y | width | height | z |
| --- | --- | --- | --- | --- | --- | --- |
| `title` | `textbox` | 24 | 16 | 608 | 56 | 9000 |
| `dateSlicer` | `slicer` | 960 | 16 | 296 | 56 | 8000 |
| `kpiRow` | `cardVisual` | 24 | 88 | 1232 | 112 | 5000 |
| `mainTrend` | `lineChart` | 24 | 216 | 1232 | 232 | 4000 |
| `periodBars` | `columnChart` | 24 | 464 | 608 | 232 | 3000 |
| `trendTable` | `tableEx` | 648 | 464 | 608 | 232 | 2000 |

Bindings: `mainTrend` = date column on Category, KPI #1 on Y, optionally category #1 on Series (only
if <= 5 distinct). `periodBars` = a coarser date grain (Year, Quarter or Month-Year column) on
Category + KPI #1 on Y.

---

## Blueprint: `comparison`

Categories against each other.

| Slot | visualType | x | y | width | height | z |
| --- | --- | --- | --- | --- | --- | --- |
| `title` | `textbox` | 24 | 16 | 608 | 56 | 9000 |
| `dateSlicer` | `slicer` | 960 | 16 | 296 | 56 | 8000 |
| `kpiRow` | `cardVisual` | 24 | 88 | 1232 | 112 | 5000 |
| `rankBars` | `barChart` | 24 | 216 | 608 | 232 | 4000 |
| `groupedBars` | `clusteredColumnChart` | 648 | 216 | 608 | 232 | 3000 |
| `matrix` | `pivotTable` | 24 | 464 | 816 | 232 | 2000 |
| `share` | `donutChart` | 856 | 464 | 400 | 232 | 1000 |

Bindings: `rankBars` = category #1 + KPI #1, sorted desc, Top 10. `groupedBars` = category #2 on
Category, category #1 on Series (<= 5 distinct), KPI #1 on Y. `matrix` = category #1 on Rows,
category #2 on Columns, KPI #1 and #2 on Values.

---

## Blueprint: `detail-table`

Rows, not charts. Use when the user asks for a list, an export, or line-level data.

| Slot | visualType | x | y | width | height | z |
| --- | --- | --- | --- | --- | --- | --- |
| `title` | `textbox` | 24 | 16 | 504 | 56 | 9000 |
| `categorySlicer` | `slicer` | 648 | 16 | 296 | 56 | 8100 |
| `dateSlicer` | `slicer` | 960 | 16 | 296 | 56 | 8000 |
| `kpiRow` | `cardVisual` | 24 | 88 | 1232 | 112 | 5000 |
| `table` | `tableEx` | 24 | 216 | 1232 | 480 | 4000 |

Bindings: `table` = 4-8 detail columns plus 1-3 measures, in the order a reader would scan them
(identifier first, measures last).

---

## Blueprint: `hero-metric`

One number is the answer; everything else explains it. Note the taller bands - two 296px rows under
the header rather than a KPI strip plus two 232px rows.

| Slot | visualType | x | y | width | height | z |
| --- | --- | --- | --- | --- | --- | --- |
| `title` | `textbox` | 24 | 16 | 608 | 56 | 9000 |
| `dateSlicer` | `slicer` | 960 | 16 | 296 | 56 | 8000 |
| `hero` | `cardVisual` | 24 | 88 | 400 | 296 | 5000 |
| `trend` | `lineChart` | 440 | 88 | 816 | 296 | 4000 |
| `breakdown` | `barChart` | 24 | 400 | 400 | 296 | 3000 |
| `comparison` | `columnChart` | 440 | 400 | 400 | 296 | 2000 |
| `composition` | `donutChart` | 856 | 400 | 400 | 296 | 1000 |

The hero slot holds **one** measure. Four cards in a tall box is just a KPI row that got stretched.

---

## Blueprint: `sidebar-detail`

KPIs run down a left rail so the charts get the full height of the page.

| Slot | visualType | x | y | width | height | z |
| --- | --- | --- | --- | --- | --- | --- |
| `title` | `textbox` | 24 | 16 | 608 | 56 | 9000 |
| `dateSlicer` | `slicer` | 960 | 16 | 296 | 56 | 8000 |
| `kpiRail` | `cardVisual` | 24 | 88 | 296 | 608 | 5000 |
| `trend` | `lineChart` | 336 | 88 | 920 | 296 | 4000 |
| `breakdown` | `barChart` | 336 | 400 | 920 | 296 | 3000 |

The 920px breakdown is the widest chart any blueprint gives you - use it when category labels are
long enough to be truncated elsewhere.

---

## Blueprint: `three-column`

A KPI strip over six equal panels. Use when several cuts matter equally.

| Slot | visualType | x | y | width | height | z |
| --- | --- | --- | --- | --- | --- | --- |
| `title` | `textbox` | 24 | 16 | 608 | 56 | 9000 |
| `dateSlicer` | `slicer` | 960 | 16 | 296 | 56 | 8000 |
| `kpiRow` | `cardVisual` | 24 | 88 | 1232 | 112 | 5000 |
| `trend` | `lineChart` | 24 | 216 | 400 | 232 | 4000 |
| `breakdown` | `barChart` | 440 | 216 | 400 | 232 | 3900 |
| `composition` | `donutChart` | 856 | 216 | 400 | 232 | 3800 |
| `comparison` | `columnChart` | 24 | 464 | 400 | 232 | 3000 |
| `matrix` | `pivotTable` | 440 | 464 | 400 | 232 | 2000 |
| `detailTable` | `tableEx` | 856 | 464 | 400 | 232 | 1000 |

400px is narrow. Do not put a wide table or a long-labelled bar chart in these panels.

---

## Building a custom layout

When no blueprint fits, derive one instead of free-handing:

1. **Reserve the header band** (y 16, h 56) - title left, slicers right. Never skip the title.
2. **Reserve the KPI band** (y 88, h 112) if there are KPI measures.
3. **Split the remaining 216..696 into 1 or 2 rows.** Three rows of charts on a 720 px canvas produce
   unreadable visuals - add a page instead.
4. **Within a row, allocate whole columns.** Every visual's width must be `104n - 16` and its `x` must
   be `24 + 104(c-1)`. Widths that do not match the formula are the usual cause of ragged edges.
5. **Same row -> same `y` and same `height`.** Always.
6. **Sum-check each row:** last visual's `x + width` must equal exactly **1256**. If it does not, your
   column allocation is wrong.

## Reading order

Western reading order is top-left to bottom-right, so place by importance:

1. Title (top-left), filters (top-right - out of the reading path).
2. Headline numbers (KPI row) - the answer, before the explanation.
3. The primary chart (largest, left of the row below).
4. Supporting breakdowns (right).
5. Detail (bottom).
