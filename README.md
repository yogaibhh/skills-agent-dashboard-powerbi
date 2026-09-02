# Power BI Dashboard Skill

[![CI](https://github.com/yogaibhh/skills-agent-dashboard-powerbi/actions/workflows/ci.yml/badge.svg)](https://github.com/yogaibhh/skills-agent-dashboard-powerbi/actions/workflows/ci.yml)

Generate complete, field-bound Power BI dashboards from a semantic model — not one visual at a time,
but a whole laid-out report you can open in Power BI Desktop or deploy to a Fabric workspace.

Ships two ways to do it:

- an **MCP server** whose tools take fields and build the JSON themselves, so the model never types a
  `queryState` — see [mcp/](mcp/);
- an **agent skill** that teaches the PBIR format directly, with PowerShell helpers — works with
  Claude Code and any runtime that reads `SKILL.md`-style skills.

## Why this exists

The official [Power BI Modeling MCP server](https://github.com/microsoft/powerbi-modeling-mcp) is
excellent at *semantic models* — tables, measures, DAX — and explicitly does not touch report
metadata. Microsoft's `powerbi-report-authoring` skill covers editing an existing report, and ships a
template whose charts arrive **unbound**: something still has to decide which fields go where, what
the JSON for each visual type looks like, and where things sit on the canvas.

This is the generation layer.

| Problem | What this supplies |
| --- | --- |
| Which fields belong on a dashboard? | Model discovery that ranks measures and category columns, and rejects identifier-shaped ones |
| Which layout? | `recommend_dashboard` ranks every layout by how much of it your model can actually fill |
| Where do visuals go? | 14 layouts with exact `x`/`y`/`width`/`height` on a 12-column grid |
| What JSON does a bound visual look like? | A catalog of complete, query-bound `visual.json` per visual type |
| Why does it look flat? | A theme builder — Power BI defaults to white cards on a white page |
| Why does every report look alike? | Harvest layouts out of reports you already have |
| Does the layout actually read well? | An HTML wireframe renderer — see the page without opening Power BI |
| Did it come out right? | Validators that check bindings, geometry and field references |

## What it produces

A PBIR report folder — the open JSON format behind PBIP projects and the Fabric Report item:

```
Sales Overview.pbip
Sales Overview.Report/
├── .platform
├── definition.pbir                       # semantic model binding
├── definition/
│   ├── report.json
│   ├── version.json
│   └── pages/
│       ├── pages.json
│       └── overview/
│           ├── page.json                 # including the page canvas colour
│           └── visuals/
│               ├── title/visual.json
│               ├── kpiRow/visual.json    # cardVisual, up to 4 measures
│               ├── trend/visual.json     # lineChart, drillable Year > Quarter > Month
│               ├── breakdown/visual.json # sorted barChart
│               └── mix/visual.json       # donutChart
└── StaticResources/RegisteredResources/theme.json
```

[examples/sales-overview](examples/sales-overview) is a worked example that passes the validator with
zero findings, alongside the wireframe it renders to.

## Install

### MCP server

```bash
cd mcp
npm install
npm run build
claude mcp add powerbi-dashboard -- node "$PWD/dist/index.js"
```

Or register it by hand:

```json
{
  "mcpServers": {
    "powerbi-dashboard": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/dist/index.js"]
    }
  }
}
```

### Skill

```
/plugin marketplace add yogaibhh/skills-agent-dashboard-powerbi
/plugin install powerbi-dashboard
```

Or copy it straight in:

```bash
cp -r plugins/powerbi-dashboard/skills/powerbi-dashboard ~/.claude/skills/
```

### Requirements

- Power BI Desktop with the **PBIP save option** enabled (Options > Preview features), to open results.
- Node 18+ for the MCP server; PowerShell 5.1 or 7+ for the scripts. Neither needs the other.
- Optional: the [Power BI Modeling MCP server](https://aka.ms/powerbi-modeling-mcp-vscode) for live
  model discovery, and [Fabric CLI](https://microsoft.github.io/fabric-cli/) for deployment.

## Use

Point an agent at a semantic model and ask:

```
Build a sales dashboard from the semantic model in ./Sales.SemanticModel
```

```
Recommend a layout for this model, then build it with a dark theme
```

```
Harvest the layouts from ./Existing.Report and save them as templates
```

The flow the tools follow:

```
inspect_semantic_model  →  what is in the model, and what is worth showing
recommend_dashboard     →  which layout fits, with arguments ready to use
create_report           →  scaffold bound to that model
apply_blueprint         →  a full page of bound visuals in one call
preview_report          →  see the layout; fix and re-run if it reads badly
validate_report         →  prove every field reference resolves
```

## MCP server

Sixteen tools. A caller says *what* goes on the page; every `queryState`, projection and literal
encoding is built server-side, because those are the parts that break silently — a role name that
does not exist, a literal missing its `L` suffix, `active: true` on the wrong projection. Power BI
accepts all of it and renders an empty box.

| | Tools |
| --- | --- |
| Discovery | `inspect_semantic_model`, `recommend_dashboard`, `list_blueprints`, `list_visual_types`, `list_theme_presets` |
| Building | `create_report`, `add_page`, `apply_blueprint`, `add_visual`, `remove_visual` |
| Look | `set_theme`, `harvest_layout` |
| Checking | `preview_report`, `validate_report`, `describe_report`, `rebind_report` |

See [mcp/README.md](mcp/README.md) for the full descriptions and design notes.

### Layouts

**7 built-in**, in two families. The first four share a shape — header, KPI strip, 2×2 grid:
`executive-overview`, `trend-analysis`, `comparison`, `detail-table`. The last three break it
deliberately: `hero-metric` (one oversized number beside a large trend), `sidebar-detail` (KPIs in a
left rail, 920px-wide charts beside them), `three-column` (a 3×2 grid of equal panels).

**7 harvested**, lifted from real reports by `harvest_layout` and shipped in
[mcp/templates/](mcp/templates/) with their source and licence recorded in
[NOTICE.md](mcp/templates/NOTICE.md).

Add your own from any report you have the rights to:

```
harvest_layout  reportPath: "...Report", save: true, attribution: { repository: "...", license: "MIT" }
```

It infers what each visual is *for* from its type and bindings, rescales the page onto the 1280×720
canvas, snaps to the grid, and reports how far anything moved.

### Themes

Seven presets — `light`, `dark`, `minimal`, `corporate`, `warm`, `contrast`, `editorial` — varying
radius, shadow, border weight and page tint together, not just hue. `set_theme` writes the theme
**and** repaints every page canvas, because a theme alone reverts to white the moment a different one
is loaded.

## PowerShell scripts

Four standalone scripts in `plugins/powerbi-dashboard/skills/powerbi-dashboard/scripts/`. They need
no Node, and CI runs them.

| Script | What it does |
| --- | --- |
| `new-dashboard.ps1` | Scaffold a PBIP report folder bound to a model |
| `preview-pbir.ps1` | Render an HTML wireframe of every page |
| `validate-pbir.ps1` | Check bindings, geometry, page indexing and field references |
| `harvest-visual-schema.ps1` | Extract real `queryState` roles and `filterConfig` bodies from existing reports |

```powershell
.\new-dashboard.ps1 -Name "Sales Overview" -OutputPath "C:\pbi\Sales" -ModelPath "..\Sales.SemanticModel"
.\preview-pbir.ps1  -ReportPath "C:\pbi\Sales\Sales Overview.Report" -Open
.\validate-pbir.ps1 -ReportPath "C:\pbi\Sales\Sales Overview.Report" -ModelPath "C:\pbi\Sales\Sales.SemanticModel"
```

The validator exits 1 on errors (`-FailOnWarning` to fail on warnings too), so it drops into CI:

| Check | Severity |
| --- | --- |
| Required files present, JSON parses | Error |
| `definition.pbir` binds to a model that exists | Error |
| Every page listed in `pages.json` → `pageOrder`, and vice versa | Error |
| Visual `name` unique across the report | Error |
| Data visuals actually have field bindings | Error |
| Every `Entity`/`Property` exists in the model's TMDL | Error |
| Table or field name differs only by case | Warning |
| Visuals overlap, or extend past the canvas | Warning |
| Page has no visuals | Warning |

## Tests

```bash
cd mcp && npm test          # 67 tests
```

```powershell
.\tests\run-tests.ps1       # 35 tests
```

The Node suite covers the grid, blueprint geometry, projection shapes, literal encoding, sort
placement, Top-N filters, theme presets, page canvas painting, TMDL reading and ranking, layout harvesting and
rescaling, validation rules and the renderer. Protocol tests spawn the real server over stdio and
drive it with a real MCP client, so tool schemas, handlers and transport are exercised the way a host
exercises them.

The PowerShell suite is dependency-free — no Pester, no modules, no network — and runs on both
editions. `-Filter "validate*"` runs a subset; `-KeepWorkspace` leaves the fixtures behind.

CI runs both on every push: PowerShell 5.1 and 7, Node 20 and 22, PSScriptAnalyzer, and a check that
the committed example still validates.

## Repository layout

```
mcp/                                     # MCP server (TypeScript)
├── src/                                 # pbir, tmdl, blueprints, visuals, generate,
│                                        #   theme, layout, recommend, validate, preview, server
├── templates/                           # harvested layouts + NOTICE.md
└── test/                                # unit + stdio protocol tests
plugins/powerbi-dashboard/
└── skills/powerbi-dashboard/
    ├── SKILL.md                         # the workflow an agent follows
    ├── references/
    │   ├── model-discovery.md           # inventory and classify model fields
    │   ├── layout-blueprints.md         # the grid and the built-in blueprints
    │   ├── visual-catalog.md            # bound visual.json per type, sorting, drill hierarchies
    │   ├── theming.md                   # why reports look flat, and the files that fix it
    │   └── deployment.md                # Desktop, Fabric, rebinding
    ├── scripts/                         # the four PowerShell tools
    └── assets/template/                 # empty PBIP scaffold
examples/sales-overview/                 # worked example + rendered wireframe
tests/run-tests.ps1                      # PowerShell test suite
.github/workflows/ci.yml                 # CI
```

## Scope

**In scope:** generating PBIR *reports* — pages, visuals, layout, field bindings, themes, deployment.

**Out of scope:** semantic models and DAX (use `powerbi-semantic-model-authoring` or the Power BI
Modeling MCP), workspace administration (use `fabric-cli`), and legacy Power BI *Dashboards* — the
pinned-tile artifact, which can only be built by cloning tiles from an existing report via the REST
API and has no file format.

## Notes on accuracy

PBIR is largely undocumented, and it fails silently: a wrong property is dropped without an error, so
a guess produces a report that looks fine until someone opens it. Three rules came out of getting
that wrong:

**Verify against real output.** The visual catalog separates roles confirmed against
Desktop-authored reports from ones that vary by version. `harvest-visual-schema.ps1` turns a
round-trip in Desktop into verified schema, and everything unverified is refused rather than guessed.

**Fetch the schema before skipping a feature.** Every PBIR file names its own `$schema`. Page
backgrounds were left out for a while as "unverifiable" when the answer was one HTTP request away.

**Prefer the layer that fails loudly.** Theme JSON is documented and ignores what it does not
recognise; per-visual formatting is silently dropped or breaks the visual. Set the look in the theme.

Generated files carry no UTF-8 BOM, matching what Power BI itself writes — the kind of difference
that stays invisible until something downstream refuses the file. The test suite asserts it.

## License

MIT — see [LICENSE](LICENSE). Harvested templates keep their own attribution; see
[mcp/templates/NOTICE.md](mcp/templates/NOTICE.md).

PBIR is a Microsoft format. This repository is an independent project, not affiliated with or
endorsed by Microsoft.
