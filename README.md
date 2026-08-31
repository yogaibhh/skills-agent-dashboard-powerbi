# Power BI Dashboard Skill

[![CI](https://github.com/yogaibhh/skills-agent-dashboard-powerbi/actions/workflows/ci.yml/badge.svg)](https://github.com/yogaibhh/skills-agent-dashboard-powerbi/actions/workflows/ci.yml)

An agent skill that generates **complete, field-bound Power BI dashboards** from a semantic model -
not a single visual at a time, but a whole laid-out report you can open in Power BI Desktop or deploy
to a Fabric workspace.

Works with Claude Code, and with any agent runtime that reads `SKILL.md`-style skills.

## Why this exists

The official [Power BI Modeling MCP server](https://github.com/microsoft/powerbi-modeling-mcp) is
excellent at *semantic models* - tables, measures, DAX, relationships - and explicitly does not touch
report metadata. Microsoft's `powerbi-report-authoring` skill covers editing an existing report, and
ships a template whose charts arrive **unbound**: an agent still has to work out which fields go where,
what the JSON for each visual type looks like, and where to put things on the canvas.

This skill fills that gap. It is the generation layer:

| Problem | What this skill supplies |
| --- | --- |
| Which fields belong on a dashboard? | A discovery + classification procedure, with DAX cardinality checks |
| Where do visuals go? | Four blueprints with exact `x`/`y`/`width`/`height` on a 12-column grid |
| What JSON does a bound visual look like? | A catalog of complete, query-bound `visual.json` per visual type |
| Does the layout actually look right? | An HTML wireframe renderer - see the page without opening Power BI |
| Did it come out right? | A PowerShell validator that checks bindings, geometry and field references |
| What about visual types nobody documented? | A harvester that reads the real schema out of existing reports |

The renderer matters more than it sounds. Generating a report is otherwise done blind: the agent
writes coordinates and hopes. `preview-pbir.ps1` closes that loop in seconds, so layout mistakes get
caught during generation rather than after launching Desktop.

## What it produces

A PBIR report folder - the open JSON format behind PBIP projects and the Fabric Report item:

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
│           ├── page.json
│           └── visuals/
│               ├── title/visual.json
│               ├── kpiRow/visual.json    # cardVisual, up to 4 measures
│               ├── trend/visual.json     # lineChart over the date table
│               ├── breakdown/visual.json # sorted barChart
│               └── mix/visual.json       # donutChart
└── StaticResources/RegisteredResources/theme.json
```

A working example lives in [examples/sales-overview](examples/sales-overview) - it passes the validator
with zero findings.

## Install

### As a Claude Code plugin

```
/plugin marketplace add yogaibhh/skills-agent-dashboard-powerbi
/plugin install powerbi-dashboard
```

### As a plain skill

Copy the skill folder into your project or user skills directory:

```bash
cp -r plugins/powerbi-dashboard/skills/powerbi-dashboard ~/.claude/skills/
```

### Requirements

- Power BI Desktop with the **PBIP save option** enabled (Options > Preview features), to open results
  locally.
- PowerShell 7+ (or Windows PowerShell 5.1) for the helper scripts.
- Optional: the [Power BI Modeling MCP server](https://aka.ms/powerbi-modeling-mcp-vscode) for live
  model discovery and DAX validation.
- Optional: [Fabric CLI](https://microsoft.github.io/fabric-cli/) (`fab`) for workspace deployment.

## Use

Point your agent at a semantic model and ask for a dashboard:

```
Build a sales dashboard from the semantic model in ./Sales.SemanticModel
```

```
Connect to 'Sales' in Power BI Desktop, then generate an executive overview page
```

```
Create a trend-analysis dashboard for semantic model <id> in the 'Analytics' workspace
```

The agent then: discovers and classifies the model -> confirms the plan with you -> scaffolds the
folder -> writes bound visuals -> validates -> hands you the `.pbip` or deploys it.

## Scripts

All four live in `plugins/powerbi-dashboard/skills/powerbi-dashboard/scripts/` and are usable on their own.

**Scaffold a report folder**

```powershell
.\new-dashboard.ps1 -Name "Sales Overview" `
                    -OutputPath "C:\pbi\SalesProject" `
                    -ModelPath "..\Sales.SemanticModel"
```

Use `-ByConnection <semanticModelId>` instead of `-ModelPath` when targeting a workspace model.

**Preview the layout as a wireframe**

```powershell
.\preview-pbir.ps1 -ReportPath "C:\pbi\SalesProject\Sales Overview.Report" -Open
```

Writes a self-contained HTML file - one to-scale SVG per page, each visual drawn as a labelled box
showing its folder name, visual type and field bindings. Boxes are colour-coded by family (card,
chart, table, slicer, text), and anything overlapping, off-canvas, or missing its field bindings is
outlined in red and listed under the page.

See [examples/sales-overview/preview.html](examples/sales-overview/preview.html) for generated output
(download and open it - GitHub will not render it inline).

**Harvest the real schema of any visual type**

```powershell
.\harvest-visual-schema.ps1 -Path "C:\pbi\MyProject" -OutputPath ".\out"
```

Scans a PBIP project (or many) and reports, per visual type: the exact `queryState` role names,
whether each role carries a Measure or a Column, the formatting groups in use, the richest example it
found, and complete `filterConfig` bodies grouped by filter type.

This is how you extend the catalog without guessing. Build a throwaway report in Desktop containing
one of every visual you want supported, bind them, save as PBIP, harvest - and the role names are
facts instead of assumptions.

**Validate before opening or deploying**

```powershell
.\validate-pbir.ps1 -ReportPath "C:\pbi\SalesProject\Sales Overview.Report" `
                    -ModelPath  "C:\pbi\SalesProject\Sales.SemanticModel"
```

Checks performed:

| Check | Severity |
| --- | --- |
| Required files present, JSON parses | Error |
| `definition.pbir` binds to a model that exists | Error |
| Every page is listed in `pages.json` -> `pageOrder`, and vice versa | Error |
| Visual `name` unique across the report | Error |
| Data visuals actually have field bindings | Error |
| Every `Entity`/`Property` exists in the model's TMDL | Error |
| Table/field name case mismatch | Warning |
| Visuals overlap, or extend past the canvas | Warning |
| Page has no visuals | Warning |

Exit code is 1 when there are errors (add `-FailOnWarning` to fail on warnings too), so it drops
straight into CI.

## Tests

```powershell
.	estsun-tests.ps1
```

35 tests covering all four scripts: scaffolding, every validator rule, wireframe rendering and schema
harvesting. No Pester, no modules, no network - it runs on Windows PowerShell 5.1 and PowerShell 7,
the same range the scripts support. `-Filter "validate*"` runs a subset; `-KeepWorkspace` leaves the
fixtures behind for inspection.

CI runs the suite on both PowerShell editions, plus PSScriptAnalyzer, plus a check that the committed
example still validates and its preview is up to date.

## Repository layout

```
.claude-plugin/marketplace.json          # plugin marketplace entry
plugins/powerbi-dashboard/
└── skills/powerbi-dashboard/
    ├── SKILL.md                         # the workflow the agent follows
    ├── references/
    │   ├── model-discovery.md           # inventory + classify model fields
    │   ├── layout-blueprints.md         # the grid and four blueprints
    │   ├── visual-catalog.md            # complete bound visual.json per type
    │   └── deployment.md                # Desktop, Fabric, rebinding
    ├── scripts/
    │   ├── new-dashboard.ps1
    │   ├── preview-pbir.ps1
    │   ├── validate-pbir.ps1
    │   └── harvest-visual-schema.ps1
    └── assets/template/                 # empty PBIP scaffold
examples/sales-overview/                 # validated worked example + rendered preview
tests/run-tests.ps1                      # dependency-free test suite
.github/workflows/ci.yml                 # tests on PS 5.1 + 7, lint, example check
```

## Scope

**In scope:** generating PBIR *reports* - pages, visuals, layout, field bindings, themes, deployment.

**Out of scope:** semantic models and DAX (use `powerbi-semantic-model-authoring` or the Power BI
Modeling MCP), workspace administration (use `fabric-cli`), and legacy Power BI *Dashboards* - the
pinned-tile artifact, which can only be built by cloning tiles from an existing report via the Power BI
REST API and has no file format.

## Notes on accuracy

The visual catalog separates role names that are **confirmed** from ones that **vary by version**. For
anything in the second group, the skill tells the agent to harvest rather than guess - a wrong
`queryState` role produces a broken visual with no error message, and `harvest-visual-schema.ps1`
turns a two-minute round-trip in Desktop into verified schema.

Generated files carry no UTF-8 BOM, matching what Power BI itself writes. The test suite asserts this,
because it is the kind of difference that is invisible until something downstream refuses the file.

## License

MIT - see [LICENSE](LICENSE).

PBIR is a Microsoft format; this repository is an independent skill and is not affiliated with or
endorsed by Microsoft.
