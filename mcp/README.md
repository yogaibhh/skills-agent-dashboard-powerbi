# powerbi-dashboard MCP server

An MCP server that builds Power BI dashboards in PBIR format. Where the skill teaches an agent to
write `visual.json` by hand, this server writes it for them.

## Why a server and not just the skill

The skill's weak point is that the model still types JSON. A `queryState` role name that does not
exist, a literal missing its `L`/`D` suffix, an `active: true` on the wrong projection - Power BI
accepts all of it silently and renders an empty box. Those are the failures that cost the most time,
because there is no error to read.

This server removes that class of mistake by construction. A caller says *what* goes on the page:

```json
{
  "blueprint": "executive-overview",
  "title": "Sales Overview",
  "kpiMeasures": [{ "table": "Sales", "field": "Total Sales", "kind": "Measure" }],
  "dateField": { "table": "Date", "field": "Date", "kind": "Column" },
  "primaryCategory": { "table": "Product", "field": "Category", "kind": "Column" }
}
```

and gets back a laid-out page of bound visuals. Every projection, literal encoding and position is
built here, and a role a visual type does not accept is rejected before anything is written.

## Install

```bash
cd mcp
npm install
npm run build
```

### Register with an MCP client

```json
{
  "mcpServers": {
    "powerbi-dashboard": {
      "command": "node",
      "args": ["/absolute/path/to/skills-agent-dashboard-powerbi/mcp/dist/index.js"]
    }
  }
}
```

In Claude Code: `claude mcp add powerbi-dashboard -- node /absolute/path/to/mcp/dist/index.js`.

The server speaks MCP over stdio and holds no state between calls - every tool takes the paths it
needs. It touches only the folders you point it at, and reaches no network.

## Tools

| Tool | What it does |
| --- | --- |
| `inspect_semantic_model` | Read TMDL and return tables, measures, columns, plus ranked KPI / date / category candidates |
| `list_blueprints` | The seven page layouts, with every slot's exact position |
| `list_visual_types` | Visual types and the roles each accepts, plus the ones needing harvest first |
| `create_report` | Scaffold a PBIP report bound to a model (`byPath` or `byConnection`) |
| `add_page` | Add a page and register it in `pages.json` |
| `apply_blueprint` | Fill a whole page with bound visuals in one call |
| `add_visual` | Write one bound visual, positioned by blueprint slot or explicit coordinates |
| `remove_visual` | Delete a visual |
| `describe_report` | Read back structure: binding, pages, visuals, bindings |
| `preview_report` | Render an HTML wireframe and summarise the layout |
| `validate_report` | Check structure, geometry, bindings and field references |
| `set_theme` | Page background, card colour, radius, shadow, palette, fonts |
| `list_theme_presets` | The available looks and the options `set_theme` takes |
| `rebind_report` | Point the report at a different model |

## A typical session

```
inspect_semantic_model  →  what is in the model, and what is worth showing
create_report           →  scaffold bound to that model
apply_blueprint         →  a full page of bound visuals
preview_report          →  see the layout; fix and re-run if it reads badly
validate_report         →  prove every field reference resolves
```

Run against the repository's example model, that produces a seven-visual page with zero findings.

## Design notes

**Skipping beats emitting empty.** `apply_blueprint` drops any slot the field assignment cannot fill
and tells you why. A missing visual is a gap; an unbound one is a blank box the user has to diagnose.

**Unverified visual types are refused, not guessed.** `gauge`, `kpi`, `treemap` and friends have
role names that shift between Power BI versions. The server will not invent them - use
`harvest-visual-schema.ps1` on a real report, then pass the harvested roles to `add_visual`.

**Theming is a first-class tool, not an afterthought.** Power BI defaults to white cards on a white
page, so a correctly generated report still looks unfinished. `set_theme` takes a preset plus a few
choices and writes the whole theme. It targets theme JSON rather than per-visual formatting because
theme JSON is documented and fails benignly - Desktop ignores a property it does not recognise,
where a wrong per-visual property can break the visual outright.

**No BOM.** Power BI's own PBIR files are UTF-8 without a byte-order mark, and so is everything
written here. The test suite asserts it.

**Deliberate duplication with the PowerShell scripts.** The `scripts/` folder stays the standalone
CLI path - it needs no Node, and CI uses it. This server reimplements the same rules in TypeScript so
it can run anywhere Node runs. Both are checked against the same example report, and both agree on
what "valid" means.

## Tests

```bash
npm test
```

47 tests. Unit tests cover the grid, blueprint geometry, projection shapes, literal encoding, sort
placement, theme presets, TMDL reading and classification, validation rules and the wireframe renderer. Protocol tests spawn the
real server over stdio and drive it with a real MCP client, so the tool schemas, handlers and
transport are exercised the way a host exercises them.

## Not yet done

- Not published to npm, so there is no `npx` install path yet.
- Bookmarks, buttons and drill-through *pages* are not modelled. Drill *hierarchies* are - pass
  several columns to one `Category` role.
- `filterConfig` (Top-N) is not built here - harvest it and pass it through.
