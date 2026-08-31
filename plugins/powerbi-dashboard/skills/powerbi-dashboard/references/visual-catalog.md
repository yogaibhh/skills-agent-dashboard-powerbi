# Visual catalog

Copy-paste-ready `visual.json` bodies, already bound to fields. Replace every `[bracketed]`
placeholder. Each file lives at
`definition/pages/<pageFolder>/visuals/<visualFolder>/visual.json`.

## The envelope

Every visual has the same outer shape:

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.1.0/schema.json",
  "name": "[20-char unique token]",
  "position": { "x": 0, "y": 0, "z": 0, "width": 0, "height": 0, "tabOrder": 0 },
  "visual": {
    "visualType": "[type]",
    "query": { "queryState": { } },
    "objects": { },
    "visualContainerObjects": { },
    "drillFilterOtherVisuals": true
  }
}
```

`objects` formats the visual's own content (data labels, axes). `visualContainerObjects` formats the
container (title, border, background). Both are optional - omit them entirely rather than leaving them
empty if you have nothing to set.

### Generating `name`

20 lowercase hex characters, unique per report. Any of these works:

```powershell
-join ((1..20) | ForEach-Object { '0123456789abcdef'[(Get-Random -Max 16)] })
```

The folder name is independent - keep folders readable (`salesByCategory`), keep `name` opaque.

## Projection primitives

Every field binding is one of exactly two shapes.

**Measure:**

```json
{
  "field": {
    "Measure": {
      "Expression": { "SourceRef": { "Entity": "[Table]" } },
      "Property": "[Measure Name]"
    }
  },
  "queryRef": "[Table].[Measure Name]",
  "nativeQueryRef": "[Measure Name]"
}
```

**Column:**

```json
{
  "field": {
    "Column": {
      "Expression": { "SourceRef": { "Entity": "[Table]" } },
      "Property": "[Column Name]"
    }
  },
  "queryRef": "[Table].[Column Name]",
  "nativeQueryRef": "[Column Name]",
  "active": true
}
```

Rules that matter:

- `queryRef` is always `Table.Field` - literally, with the dot, no brackets, no quotes.
- `nativeQueryRef` is the bare field name; it is what shows in the field well and default titles.
- `active: true` goes on the **first** projection of a role only. Omit it elsewhere.
- Both are case-sensitive and must match the model exactly.
- A date column binds like any other column. You do not need the auto date hierarchy; binding the raw
  date column is more portable and survives model changes better.

## Literal encoding in `objects`

Property values are wrapped expressions, and the suffix encodes the type. Getting this wrong silently
drops the setting:

| Value | Encoding |
| --- | --- |
| text | `"'Sales by Category'"` (single quotes **inside** the string) |
| integer | `"4L"` |
| decimal / font size | `"12D"` |
| boolean | `"true"` / `"false"` |
| date | `"datetime'2024-01-01T00:00:00'"` |

```json
"show": { "expr": { "Literal": { "Value": "true" } } }
```

---

## Role reference

Which `queryState` keys a visual type accepts.

### Confirmed

| visualType | Roles |
| --- | --- |
| `cardVisual` (new card) | `Data` |
| `card` (legacy single card) | `Values` |
| `multiRowCard` | `Values` |
| `slicer` | `Values` (exactly one field) |
| `barChart` (horizontal) | `Category`, `Y`, `Series` |
| `columnChart` (vertical) | `Category`, `Y`, `Series` |
| `clusteredBarChart` | `Category`, `Y`, `Series` |
| `clusteredColumnChart` | `Category`, `Y`, `Series` |
| `lineChart` | `Category`, `Y`, `Series` |
| `areaChart` | `Category`, `Y`, `Series` |
| `stackedAreaChart` | `Category`, `Y`, `Series` |
| `pieChart` | `Category`, `Y` |
| `donutChart` | `Category`, `Y` |
| `tableEx` (table) | `Values` |
| `pivotTable` (matrix) | `Rows`, `Columns`, `Values` |
| `textbox` | none |
| `image` | none |

### Verify before use

These types exist and are commonly used, but their role names shift between versions. Do not guess -
run the round-trip procedure below and copy the real JSON.

`gauge`, `kpi`, `scatterChart`, `treemap`, `funnel`, `waterfallChart`, `lineStackedColumnComboChart`,
`lineClusteredColumnComboChart`, `map`, `filledMap`, `shapeMap`, `ribbonChart`, `decompositionTreeVisual`,
`keyDriversVisual`, and every custom/AppSource visual.

### Round-trip procedure (authoritative for any visual)

1. In Power BI Desktop, create the visual you want and bind its fields by hand.
2. Save as a **PBIP** project (File > Save as > `.pbip`), or enable
   *Options > Preview features > Power BI Project (.pbip) save option*.
3. Run the harvester over the saved project:

   ```powershell
   scripts/harvest-visual-schema.ps1 -Path "C:\pbi\MyProject" -OutputPath ".\out"
   ```

4. Read `out/visual-schema.md`. For every visual type it found, it reports the exact `queryState`
   role names, whether each role carries a `Measure` or a `Column`, how many fields a role was seen
   holding, which `objects` formatting groups are in use, and the richest `queryState` it saw -
   ready to paste in here.

This is the only reliable source for undocumented visuals. Do it once, for as many visual types as you
care about, and the guessing is gone permanently: build a throwaway report containing one of every
visual you want supported, bind each one, save as PBIP, harvest.

You can also point the harvester at reports you already have - it aggregates across any number of
them, and reports how often each role appeared and in which report.

---

## Title (textbox)

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.1.0/schema.json",
  "name": "[unique]",
  "position": { "x": 24, "y": 16, "z": 9000, "width": 608, "height": 56, "tabOrder": 6000 },
  "visual": {
    "visualType": "textbox",
    "objects": {
      "general": [
        {
          "properties": {
            "paragraphs": [
              {
                "textRuns": [
                  {
                    "value": "[Dashboard Title]",
                    "textStyle": { "fontFamily": "Segoe UI Semibold", "fontSize": "24pt", "color": "#252423" }
                  }
                ]
              }
            ]
          }
        }
      ]
    },
    "drillFilterOtherVisuals": true
  }
}
```

A subtitle is a second paragraph object in the same `paragraphs` array, with a smaller `fontSize` and
a muted `color` (`#605E5C`).

## KPI row (cardVisual)

One container, up to four measures, laid out in four columns. Preferred over four separate cards - it
stays aligned automatically.

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.1.0/schema.json",
  "name": "[unique]",
  "position": { "x": 24, "y": 88, "z": 5000, "width": 1232, "height": 112, "tabOrder": 5000 },
  "visual": {
    "visualType": "cardVisual",
    "query": {
      "queryState": {
        "Data": {
          "projections": [
            {
              "field": { "Measure": { "Expression": { "SourceRef": { "Entity": "[Table]" } }, "Property": "[Measure 1]" } },
              "queryRef": "[Table].[Measure 1]",
              "nativeQueryRef": "[Measure 1]"
            },
            {
              "field": { "Measure": { "Expression": { "SourceRef": { "Entity": "[Table]" } }, "Property": "[Measure 2]" } },
              "queryRef": "[Table].[Measure 2]",
              "nativeQueryRef": "[Measure 2]"
            }
          ]
        }
      }
    },
    "objects": {
      "layout": [
        {
          "properties": {
            "orientation": { "expr": { "Literal": { "Value": "0D" } } },
            "columnCount": { "expr": { "Literal": { "Value": "4L" } } },
            "alignment": { "expr": { "Literal": { "Value": "'middle'" } } },
            "style": { "expr": { "Literal": { "Value": "'Cards'" } } }
          }
        }
      ],
      "value": [
        {
          "properties": { "fontSize": { "expr": { "Literal": { "Value": "28D" } } } },
          "selector": { "id": "default" }
        }
      ],
      "accentBar": [
        { "properties": { "show": { "expr": { "Literal": { "Value": "false" } } } }, "selector": { "id": "default" } }
      ]
    },
    "visualContainerObjects": {
      "title": [ { "properties": { "show": { "expr": { "Literal": { "Value": "false" } } } } } ]
    },
    "drillFilterOtherVisuals": true
  }
}
```

Set `columnCount` to the actual number of measures (2, 3 or 4) so the cards fill the width evenly.

## Date slicer

`Between` mode gives a two-ended date range picker.

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.1.0/schema.json",
  "name": "[unique]",
  "position": { "x": 960, "y": 16, "z": 8000, "width": 296, "height": 56, "tabOrder": 7000 },
  "visual": {
    "visualType": "slicer",
    "query": {
      "queryState": {
        "Values": {
          "projections": [
            {
              "field": { "Column": { "Expression": { "SourceRef": { "Entity": "[Date Table]" } }, "Property": "[Date Column]" } },
              "queryRef": "[Date Table].[Date Column]",
              "nativeQueryRef": "[Date Column]",
              "active": true
            }
          ]
        }
      }
    },
    "objects": {
      "data": [ { "properties": { "mode": { "expr": { "Literal": { "Value": "'Between'" } } } } } ]
    },
    "drillFilterOtherVisuals": true
  }
}
```

## Category slicer

Same envelope, different `mode`. Use `'Dropdown'` when horizontal space is tight, `'Basic'` for a list.

```json
"objects": {
  "data": [ { "properties": { "mode": { "expr": { "Literal": { "Value": "'Dropdown'" } } } } } ]
}
```

Bind a **column**, never a measure. One field only.

## Bar chart (sorted ranking)

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.1.0/schema.json",
  "name": "[unique]",
  "position": { "x": 856, "y": 216, "z": 3000, "width": 400, "height": 232, "tabOrder": 3000 },
  "visual": {
    "visualType": "barChart",
    "query": {
      "queryState": {
        "Category": {
          "projections": [
            {
              "field": { "Column": { "Expression": { "SourceRef": { "Entity": "[Dim Table]" } }, "Property": "[Category Column]" } },
              "queryRef": "[Dim Table].[Category Column]",
              "nativeQueryRef": "[Category Column]",
              "active": true
            }
          ]
        },
        "Y": {
          "projections": [
            {
              "field": { "Measure": { "Expression": { "SourceRef": { "Entity": "[Fact Table]" } }, "Property": "[Measure]" } },
              "queryRef": "[Fact Table].[Measure]",
              "nativeQueryRef": "[Measure]"
            }
          ]
        }
      }
    },
    "sortDefinition": {
      "sort": [
        {
          "field": { "Measure": { "Expression": { "SourceRef": { "Entity": "[Fact Table]" } }, "Property": "[Measure]" } },
          "direction": "Descending"
        }
      ],
      "isDefaultSort": true
    },
    "visualContainerObjects": {
      "title": [
        {
          "properties": {
            "show": { "expr": { "Literal": { "Value": "true" } } },
            "text": { "expr": { "Literal": { "Value": "'[Measure] by [Category Column]'" } } }
          }
        }
      ]
    },
    "drillFilterOtherVisuals": true
  }
}
```

`columnChart` is the same JSON with `"visualType": "columnChart"` - use it when category labels are
short and you want vertical bars.

## Line chart (trend over time)

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.1.0/schema.json",
  "name": "[unique]",
  "position": { "x": 24, "y": 216, "z": 4000, "width": 816, "height": 232, "tabOrder": 2000 },
  "visual": {
    "visualType": "lineChart",
    "query": {
      "queryState": {
        "Category": {
          "projections": [
            {
              "field": { "Column": { "Expression": { "SourceRef": { "Entity": "[Date Table]" } }, "Property": "[Date Column]" } },
              "queryRef": "[Date Table].[Date Column]",
              "nativeQueryRef": "[Date Column]",
              "active": true
            }
          ]
        },
        "Y": {
          "projections": [
            {
              "field": { "Measure": { "Expression": { "SourceRef": { "Entity": "[Fact Table]" } }, "Property": "[Measure]" } },
              "queryRef": "[Fact Table].[Measure]",
              "nativeQueryRef": "[Measure]"
            }
          ]
        }
      }
    },
    "visualContainerObjects": {
      "title": [
        {
          "properties": {
            "show": { "expr": { "Literal": { "Value": "true" } } },
            "text": { "expr": { "Literal": { "Value": "'[Measure] over time'" } } }
          }
        }
      ]
    },
    "drillFilterOtherVisuals": true
  }
}
```

Add a `Series` role only when the splitting column has <= 5 distinct values - more lines than that is
spaghetti. `areaChart` and `stackedAreaChart` take the same roles.

## Donut chart (composition)

Same shape as the bar chart with `"visualType": "donutChart"` and roles `Category` + `Y`. Only use it
when the category has **2-7** values; above that a sorted bar chart reads better.

Turn the legend off and labels on for a compact donut:

```json
"objects": {
  "legend": [ { "properties": { "show": { "expr": { "Literal": { "Value": "false" } } } } } ],
  "labels": [ { "properties": { "show": { "expr": { "Literal": { "Value": "true" } } } } } ]
}
```

## Table (`tableEx`)

All fields go into the single `Values` role, in display order.

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.1.0/schema.json",
  "name": "[unique]",
  "position": { "x": 24, "y": 464, "z": 2000, "width": 816, "height": 232, "tabOrder": 1000 },
  "visual": {
    "visualType": "tableEx",
    "query": {
      "queryState": {
        "Values": {
          "projections": [
            {
              "field": { "Column": { "Expression": { "SourceRef": { "Entity": "[Dim Table]" } }, "Property": "[Column]" } },
              "queryRef": "[Dim Table].[Column]",
              "nativeQueryRef": "[Column]",
              "active": true
            },
            {
              "field": { "Measure": { "Expression": { "SourceRef": { "Entity": "[Fact Table]" } }, "Property": "[Measure]" } },
              "queryRef": "[Fact Table].[Measure]",
              "nativeQueryRef": "[Measure]"
            }
          ]
        }
      }
    },
    "drillFilterOtherVisuals": true
  }
}
```

Identifier columns first, measures last. Keep it under ~8 fields; wider tables need horizontal
scrolling and stop being readable.

## Matrix (`pivotTable`)

```json
"query": {
  "queryState": {
    "Rows": { "projections": [ /* column projection */ ] },
    "Columns": { "projections": [ /* column projection */ ] },
    "Values": { "projections": [ /* one or more measure projections */ ] }
  }
}
```

Keep `Columns` under ~8 distinct values or the matrix scrolls sideways.

---

## Formatting recipes

Drop these into `objects` (visual content) or `visualContainerObjects` (container chrome).

**Container title with explicit text** - `visualContainerObjects`:

```json
"title": [
  {
    "properties": {
      "show": { "expr": { "Literal": { "Value": "true" } } },
      "text": { "expr": { "Literal": { "Value": "'Revenue by Region'" } } },
      "fontSize": { "expr": { "Literal": { "Value": "12D" } } },
      "fontColor": { "solid": { "color": { "expr": { "Literal": { "Value": "'#252423'" } } } } }
    }
  }
]
```

**Hide the title** (for cards and slicers that speak for themselves):

```json
"title": [ { "properties": { "show": { "expr": { "Literal": { "Value": "false" } } } } } ]
```

**Rounded border** - `visualContainerObjects`:

```json
"border": [
  {
    "properties": {
      "show": { "expr": { "Literal": { "Value": "true" } } },
      "radius": { "expr": { "Literal": { "Value": "8L" } } }
    }
  }
]
```

**Data labels on** - `objects`:

```json
"labels": [ { "properties": { "show": { "expr": { "Literal": { "Value": "true" } } } } } ]
```

**Legend off / repositioned** - `objects`:

```json
"legend": [
  {
    "properties": {
      "show": { "expr": { "Literal": { "Value": "true" } } },
      "position": { "expr": { "Literal": { "Value": "'Top'" } } }
    }
  }
]
```

**Theme color instead of a hex literal** - references slot N of the report theme's `dataColors`:

```json
"fontColor": { "solid": { "color": { "expr": { "ThemeDataColor": { "ColorId": 1, "Percent": 0 } } } } }
```

Prefer `ThemeDataColor` over hex where you can - it keeps the report consistent when the theme changes.

## Top-N filtering

Visual-level filters live in a `filterConfig` object on the visual. The exact filter body varies by
Power BI version, so **do not hand-write it** - author one Top-N filter in Desktop, save as PBIP, and
run `scripts/harvest-visual-schema.ps1` over it. The harvester has a dedicated Filters section that
emits one complete, copyable example per filter type (`TopN`, `Categorical`, `Advanced`, ...). The
structure is:

```json
"filterConfig": {
  "filters": [
    {
      "name": "[unique filter name]",
      "field": { "Column": { "Expression": { "SourceRef": { "Entity": "[Dim]" } }, "Property": "[Col]" } },
      "type": "TopN",
      "filter": { "...copied from Desktop..." },
      "howCreated": "Auto"
    }
  ]
}
```

If you cannot round-trip, the safe fallback is to sort descending and leave the chart scrollable, or
to bind a category that is already small enough. A wrong `filterConfig` breaks the whole visual; a
missing one only makes it busier.
