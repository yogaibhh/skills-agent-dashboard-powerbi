# Example: Sales Overview

A generated `executive-overview` dashboard, kept here as a structural reference. It passes the
validator with zero findings:

```powershell
..\..\plugins\powerbi-dashboard\skills\powerbi-dashboard\scripts\validate-pbir.ps1 `
    -ReportPath ".\Sales Overview.Report" `
    -ModelPath  ".\Sales.SemanticModel"
```

## What is here

```
Sales Overview.pbip
Sales Overview.Report/definition/pages/overview/visuals/
├── title/       textbox      24,16    608x56    "Sales Overview"
├── kpiRow/      cardVisual   24,88   1232x112   Total Sales, Total Orders
├── trend/       lineChart    24,216   816x232   Date[Date] x Sales[Total Sales]
├── breakdown/   barChart    856,216   400x232   Product[Category] x Sales[Total Sales]
└── mix/         donutChart  856,464   400x232   Product[Category] x Sales[Total Sales]
```

Coordinates come straight from the `executive-overview` blueprint in
[layout-blueprints.md](../../plugins/powerbi-dashboard/skills/powerbi-dashboard/references/layout-blueprints.md).
Note that `detailTable` from that blueprint is omitted here - the demo model has no useful detail
columns, and dropping a slot is preferable to filling it with noise.

## About the semantic model

`Sales.SemanticModel` is a **metadata-only stub**: three tables (`Sales`, `Date`, `Product`) with
measures and columns declared in TMDL, but no Power Query partitions and no data source.

That is enough to demonstrate and validate the report structure, and enough for the validator to check
every field reference. It is **not** enough to render data - opening the `.pbip` in Power BI Desktop
will show the layout with empty visuals. Point a report at a real model to see numbers.
