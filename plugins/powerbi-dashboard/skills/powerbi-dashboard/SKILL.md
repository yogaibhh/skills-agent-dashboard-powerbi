---
name: powerbi-dashboard
description: Generate a complete, ready-to-open Power BI dashboard from a semantic model. Use this skill when the user asks to "build/create/generate a dashboard", "make a report from this model", "auto-generate Power BI visuals", or wants a multi-visual PBIR report scaffolded end to end - including field discovery, layout, KPI cards, charts, slicers, validation, and deployment to Fabric. Do NOT use for editing a single visual in an existing report (use powerbi-report-authoring), for semantic model / TMDL / DAX work (use powerbi-semantic-model-authoring), or for workspace administration (use fabric-cli).
---

# Power BI Dashboard Builder

Turn a semantic model into a finished, laid-out, field-bound Power BI report in **PBIR** format - the
JSON report format used by PBIP projects and by the Fabric Report item definition.

This skill is the *generation* layer. It assumes you can already read a semantic model and write files.
It supplies the three things generation actually needs and that generic report guidance does not
provide: a **field-classification procedure**, **layout blueprints with exact coordinates**, and a
**catalog of complete, query-bound visual JSON** you can copy and fill in.

## Critical rules

1. **Bind every visual.** A `visual.json` without a `query.queryState` renders as an empty placeholder.
   Every chart, card, table and slicer you emit must carry real `Entity` / `Property` references.
   This is the single most common failure - do not ship an unbound visual.
2. **Names are case-sensitive.** `Entity` must match the semantic model table name exactly, and
   `Property` the measure or column name exactly. A typo produces a broken visual, not an error.
3. **Never invent fields.** Only reference tables, columns and measures you have actually read from the
   model. If the model lacks a measure the dashboard needs, either create it first (via the
   `powerbi-semantic-model-authoring` skill / Power BI Modeling MCP) or drop the visual - never guess.
4. **`name` must be unique and stable.** Every page and visual carries an internal `name` (a 20-char
   hex token). Generate one per object, keep it unique within the report, and keep folder names
   readable (`overview`, `salesByRegion`) - the folder name and the internal `name` are independent.
5. **Validate before declaring done.** Run `scripts/validate-pbir.ps1`. It catches unbound visuals,
   overlaps, out-of-bounds positions, orphaned pages and broken index files.
6. **Look at what you generated.** Run `scripts/preview-pbir.ps1` and read the wireframe it produces.
   Writing coordinates blind is how dashboards end up technically valid and visually wrong - the
   preview is the only feedback you get without launching Power BI Desktop.

## If the powerbi-dashboard MCP server is available, use it

Check your tool list for `apply_blueprint`, `add_visual` and `validate_report`. If they are there,
**prefer them over writing `visual.json` by hand** - they build the same JSON this skill documents,
but the roles, projections and literal encodings come from code rather than from you, which removes
the whole class of silently-broken visuals.

The mapping onto the workflow below:

| Step | MCP tool |
| --- | --- |
| 1 - discover the model | `inspect_semantic_model` |
| 3 - pick a blueprint | `list_blueprints` |
| 4 - scaffold | `create_report`, `add_page` |
| 5 - emit visuals | `apply_blueprint` for a whole page, `add_visual` for one |
| 6 - preview and validate | `preview_report`, `validate_report` |
| any time - fix a flat look | `set_theme`, `list_theme_presets` |

Steps 1, 2, 3 and 6 still apply unchanged - the tools do not choose fields or judge a layout for you.
Read the reference files for *what* to put where; the server only handles *how* it is written.

Without the server, follow the workflow as written.

## Prerequisites

- The report must target an existing semantic model (local PBIP folder, Power BI Desktop, or a Fabric
  workspace model). This skill does not create semantic models.
- Optional but recommended: the [Power BI Modeling MCP server](https://aka.ms/powerbi-modeling-mcp-vscode)
  for live model discovery and DAX validation.
- PowerShell 7+ to run the helper scripts (Windows PowerShell 5.1 also works).

## Workflow: build a dashboard from scratch

Follow these six steps in order. Do not skip step 1 - every later decision depends on it.

### Step 1 - Discover and classify the model

Read [references/model-discovery.md](references/model-discovery.md) and produce a **field inventory**:
which measures are headline KPIs, which table is the date/calendar table, which columns are usable
categories (low cardinality) versus unusable (high-cardinality keys, free text).

Do not proceed until you can name: the fact table, the date table and its date column, 2-6 candidate
KPI measures, and 2-5 category columns.

### Step 2 - Confirm intent with the user

State the plan in one short block and get a yes before writing files:

- the dashboard's subject and title,
- which measures go on the KPI row (max 4),
- which blueprint you will use (see step 3),
- where the output folder goes.

Ask only if the answer changes the output. If the user said "just build it", pick sensible defaults
from the inventory and say what you chose.

### Step 3 - Pick a layout blueprint

Read [references/layout-blueprints.md](references/layout-blueprints.md) and choose:

| Blueprint | Use when |
| --- | --- |
| `executive-overview` | Default. KPI row + trend + breakdown + detail. |
| `trend-analysis` | The question is "how did this change over time". |
| `comparison` | Comparing categories or segments against each other. |
| `detail-table` | The user wants rows, not charts. |
| `hero-metric` | One number is the answer. Oversized card beside a large trend. |
| `sidebar-detail` | Charts need room; KPIs go in a left rail instead of a top strip. |
| `three-column` | Several equally important cuts, no single hero. 3x2 grid. |

The first four share one shape - header, KPI strip, 2x2 grid. Reaching for them every time is what
makes a set of generated reports look identical. The last three break that shape on purpose: pick by
the question being asked, not by habit.

Blueprints give exact `x`/`y`/`width`/`height` per slot on the standard 1280x720 canvas. Use them - do
not free-hand coordinates.

### Step 4 - Scaffold the report folder

```powershell
scripts/new-dashboard.ps1 -Name "Sales Overview" -OutputPath "C:\path\to\project" -ModelPath "..\Sales.SemanticModel"
```

This copies `assets/template/` into `<OutputPath>/<Name>.Report/`, generates a fresh `logicalId`, sets
`displayName`, writes a `<Name>.pbip` next to it, and wires `definition.pbir` to the semantic model.
Use `-ByConnection <semanticModelId>` instead of `-ModelPath` when the target model lives in a Fabric
workspace.

The scaffold ships one empty page (`overview`) and no visuals. You add the visuals in step 5.

### Step 5 - Emit the visuals

For each slot in the blueprint, copy the matching entry from
[references/visual-catalog.md](references/visual-catalog.md), fill in the placeholders, and write it to:

```
<Name>.Report/definition/pages/<pageFolder>/visuals/<visualFolder>/visual.json
```

Fill order per visual: `name` -> `position` (from the blueprint) -> `visualType` -> `query.queryState`
(from the catalog's role table) -> optional `objects` formatting.

Always include, in this order:

1. a **title** textbox and, if the model has a date table, a **date slicer**;
2. the **KPI row** - one `cardVisual` holding up to 4 measures;
3. the blueprint's chart slots;
4. optionally a **detail table** at the bottom.

### Step 6 - Preview, validate, then hand off

**Preview first.** Render the wireframe and actually read it:

```powershell
scripts/preview-pbir.ps1 -ReportPath "C:\path\to\Sales Overview.Report"
```

This writes a self-contained HTML file: one to-scale SVG per page, every visual drawn as a labelled
box showing its folder name, type and field bindings, with anything broken outlined in red. Check
against the blueprint you chose:

- Does each row line up, and does every row end at x = 1256?
- Is the reading order right - title, KPIs, primary chart, supporting, detail?
- Any box carrying only its folder name? That means no bindings were found.
- Any red box or issue in the list under the page?

If something looks wrong, fix the `visual.json` and re-render. This loop costs seconds; discovering
the same problem after opening Desktop costs minutes.

**Then validate:**

```powershell
scripts/validate-pbir.ps1 -ReportPath "C:\path\to\Sales Overview.Report" -ModelPath "C:\path\to\Sales.SemanticModel"
```

The two are complementary: the preview shows you geometry and shape, the validator proves the field
references actually resolve against the model.

Fix every Error before reporting completion; report Warnings to the user with your reasoning. Then
either open the `.pbip` in Power BI Desktop or deploy - see
[references/deployment.md](references/deployment.md).

When you hand off, give the user the preview file path alongside the `.pbip` - it is the fastest way
for them to review the layout without opening anything.

## Workflow: add a page to an existing dashboard

1. Read `definition/pages/pages.json` and every existing `page.json` so the new page matches the
   report's conventions (canvas size, theme, header treatment).
2. Create `definition/pages/<newFolder>/page.json` with a fresh unique `name`.
3. Add that `name` to `pageOrder` in `pages.json`. Leave `activePageName` pointing at the landing page
   unless the user asks otherwise.
4. Emit visuals per step 5, then validate per step 6.

## Workflow: rebind a dashboard to a different model

Edit `definition.pbir` only - `byPath` for a local model folder, `byConnection` for a workspace model.
Then re-run the validator with the new `-ModelPath`: it reports every `Entity`/`Property` reference the
new model does not satisfy. Fix those before deploying.

See [references/deployment.md](references/deployment.md) for both reference shapes.

## Quality bar

A dashboard is not done until all of these hold:

- [ ] Every visual is bound to real fields; none render empty.
- [ ] The page has a title, and a date slicer when a date table exists.
- [ ] The KPI row has 2-4 measures, no more.
- [ ] No two visuals overlap; nothing extends past 1280x720.
- [ ] Visuals in the same row share the same `y` and `height`.
- [ ] Charts with more than ~8 categories are sorted and Top-N filtered.
- [ ] Every visual has a meaningful title, or `title.show = false` when the content is self-evident.
- [ ] The page background differs from the card background - see [theming](references/theming.md).
- [ ] `preview-pbir.ps1` was rendered and read, and the layout matches the blueprint.
- [ ] `validate-pbir.ps1` reports zero Errors.

## Anti-patterns

- **Wall of cards.** More than 4 KPIs on one row makes each unreadable. Move the extras to a second page.
- **Pie charts with 10 slices.** Use a sorted bar chart above 5 categories.
- **Unfiltered high-cardinality categories.** A bar chart over 5,000 customers is a solid block. Top-N it.
- **Copying the whole template then deleting.** Emit only the visuals the blueprint calls for.
- **Deploying with `byPath`.** Workspace deployment requires `byConnection`; it fails otherwise.

## Relationship to other skills

| Need | Skill |
| --- | --- |
| Build a whole dashboard from a model | **this skill** |
| Tweak one visual / align an existing report | `powerbi-report-authoring` |
| Tables, measures, DAX, TMDL | `powerbi-semantic-model-authoring` |
| Workspaces, deploy, export, pipelines | `fabric-cli` |

## References

- [references/model-discovery.md](references/model-discovery.md) - inventory and classify model fields.
- [references/layout-blueprints.md](references/layout-blueprints.md) - the grid and four blueprints.
- [references/visual-catalog.md](references/visual-catalog.md) - complete, bound `visual.json` per type.
- [references/theming.md](references/theming.md) - why generated reports look flat, and the one file that fixes it.
- [references/deployment.md](references/deployment.md) - open in Desktop, deploy to Fabric, rebind.
- [PBIR format docs](https://learn.microsoft.com/power-bi/developer/projects/projects-report?tabs=v2%2Cdesktop#pbir-format)

### Scripts

| Script | Purpose |
| --- | --- |
| `scripts/new-dashboard.ps1` | Scaffold a PBIP report folder bound to a semantic model |
| `scripts/preview-pbir.ps1` | Render an HTML wireframe of every page - use it after writing visuals |
| `scripts/validate-pbir.ps1` | Check bindings, geometry, page indexing and field references |
| `scripts/harvest-visual-schema.ps1` | Extract real role names and `filterConfig` bodies from existing reports |

Run each with `-?` for full parameter help.

Reach for the harvester whenever you need a visual type the catalog lists under "verify before use",
or a `filterConfig` shape. Point it at any PBIP project and it reports what that report actually
contains - which beats guessing and beats reading JSON by hand.
