# Theming

The single biggest reason a generated dashboard looks unfinished: **Power BI defaults to white cards
on a white page**, so no visual has an edge. Everything reads as one flat sheet. Fixing that is one
file, and it costs nothing at generation time.

## Where the look lives

| Layer | File | Risk |
| --- | --- | --- |
| Report theme | `StaticResources/RegisteredResources/theme.json` | **Low** - a documented public format; Desktop ignores properties it does not know |
| Page canvas | `objects` in each `page.json` | **Low** - `background` and `outspace` are in the published page schema |
| Per-visual formatting | `objects` / `visualContainerObjects` in each `visual.json` | **High** - a wrong property name is dropped silently, a wrong shape can break the visual |

Prefer the theme. It applies to every visual at once, survives regeneration, and fails benignly.
Reach for per-visual formatting only for something genuinely one-off.

**Set the canvas in both places.** The theme's `visualStyles.page` styles the canvas only while that
theme file is applied; load a different theme and the page falls back to white, undoing the look.
Writing it into `page.json` as well makes the canvas a property of the report. `set_theme` does both,
and repaints every existing page.

```json
"objects": {
  "background": [
    {
      "properties": {
        "color": { "solid": { "color": { "expr": { "Literal": { "Value": "'#F5F6FA'" } } } } },
        "transparency": { "expr": { "Literal": { "Value": "0D" } } }
      }
    }
  ],
  "outspace": [ { "properties": { "color": { "solid": { "color": { "expr": { "Literal": { "Value": "'#EBECF2'" } } } } } } } ]
}
```

Unlike theme JSON, this **is** PBIR, so colours are expression-wrapped and numbers carry their type
suffix. The shape is from the published `page/1.4.0` schema, which defines `objects.background` and
`objects.outspace` as arrays of `{ properties: { color, image, transparency } }` - fetch the `$schema`
URL at the top of any PBIR file when you need to check a property rather than guessing at it.

Note that theme JSON is **not** PBIR: colours are plain strings, not `expr`/`Literal` wrappers.

```json
"background": [{ "show": true, "color": { "solid": { "color": "#FFFFFF" } } }]
```

## The rule that matters

**The page and the cards must not be the same colour.** Everything else is taste.

```json
"visualStyles": {
  "page": {
    "*": {
      "background": [{ "color": { "solid": { "color": "#F5F6FA" } }, "transparency": 0 }],
      "outspace": [{ "color": { "solid": { "color": "#EBECF2" } }, "transparency": 0 }]
    }
  },
  "*": {
    "*": {
      "background": [{ "show": true, "color": { "solid": { "color": "#FFFFFF" } }, "transparency": 0 }],
      "border": [{ "show": true, "color": { "solid": { "color": "#E3E5EC" } }, "radius": 8 }],
      "dropShadow": [{ "show": true, "color": { "solid": { "color": "#000000" } }, "position": "Outer", "preset": "BottomRight" }]
    }
  }
}
```

`page` is the canvas; `outspace` is the grey area around it when the canvas does not fill the window.

## Per-type overrides worth making

Some visuals look wrong wearing the default card chrome:

| Type | Override | Why |
| --- | --- | --- |
| `textbox` | background and border off | A page title should not look like a panel |
| `cardVisual` | border off | The KPI strip is one container; inner borders make it look boxed-in |
| `slicer` | keep the card look | Slicers read as controls, and the border says "clickable" |

## Structural colours

Power BI derives a lot of chrome from these, so setting them is what makes a theme feel coherent
instead of a recoloured default:

| Property | Used for |
| --- | --- |
| `firstLevelElements` | Primary text |
| `secondLevelElements` | Secondary text, axis labels |
| `thirdLevelElements` | Gridlines |
| `fourthLevelElements` | Dividers |
| `background` / `secondaryBackground` | Card and canvas |
| `tableAccent` | Table and matrix accents |
| `good` / `neutral` / `bad` | KPI and conditional formatting |

Also set `textClasses` for `callout` (the big KPI number), `title`, `header` and `label`. A callout
that is not clearly larger than a label is the other common reason a dashboard reads as flat.

## Presets

Seven, and they differ in more than hue - radius, shadow, border weight and page tint all move
together, because those are what actually make two reports look like different products.

| Preset | Look |
| --- | --- |
| `light` | Default. White cards on cool grey, 8px radius, soft shadow. |
| `dark` | Light text on near-black, brighter series. |
| `minimal` | No fills or shadows; whitespace does the separating. |
| `corporate` | Deep navy on a cool page, square-ish corners, no shadow. |
| `warm` | Cream page, earthy palette, generous 12px radius. |
| `contrast` | Heavier borders and saturated series, for projectors and low-vision readers. |
| `editorial` | Quiet and typographic: muted series, hairline borders. |

## Generating one

The MCP server builds all of this from a few choices:

```
set_theme  reportPath, preset: light | dark | minimal, accent, cornerRadius, shadow, ...
```

`list_theme_presets` returns what is available. A theme change needs no data refresh - reopen the
report and it is applied.

Without the server, copy the block above into
`StaticResources/RegisteredResources/theme.json` and edit the colours. The template shipped in
`assets/template/` is the `light` preset and is a reasonable starting point.

## Palette

Keep categorical colours to 8 or fewer, and order them so the first is the one most series use. The
default palette is a standard categorical set chosen for contrast against both a white card and a
light grey page:

```
#2C5F9E  #E07B39  #3E9E6B  #C0504D  #7A5EA8  #178A8F  #C9A227  #6B7B8C
```

If a brand colour is required, pass it as the accent rather than replacing the whole palette - it
leads the series order and becomes the table accent, and the rest stays balanced around it.
