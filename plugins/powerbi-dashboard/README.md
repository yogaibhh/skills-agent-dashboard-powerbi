# powerbi-dashboard plugin

Generates complete, field-bound Power BI dashboards (PBIR reports) from a semantic model.

Ships one skill:

| Skill | Purpose |
| --- | --- |
| `powerbi-dashboard` | End-to-end dashboard generation: model discovery, layout, bound visuals, validation, deployment |

## Triggers

The skill activates on requests like:

- "build a dashboard from this semantic model"
- "generate a Power BI report for the Sales model"
- "create an executive overview page"
- "auto-generate visuals from these measures"

It stays out of the way for single-visual edits (`powerbi-report-authoring`), model and DAX work
(`powerbi-semantic-model-authoring`), and workspace administration (`fabric-cli`).

## Contents

```
skills/powerbi-dashboard/
├── SKILL.md              # the six-step workflow
├── references/           # discovery, blueprints, visual catalog, deployment
├── scripts/              # new-dashboard.ps1, preview-pbir.ps1, validate-pbir.ps1
└── assets/template/      # empty PBIP scaffold copied by new-dashboard.ps1
```

See the [repository README](../../README.md) for installation and usage.
