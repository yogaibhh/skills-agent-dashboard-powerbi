# Template attribution

Each `*.json` here is a **layout** - slot positions, visual types, and an inferred role per slot.
No field bindings, no data, no text content: `harvest_layout` reads structure and discards everything
else. Every file records where it came from and under what licence in its `attribution` block.

| Template | Source | Licence |
| --- | --- | --- |
| `vizzle-getting-started` | [PBI-DataVizzle/pbi_content](https://github.com/PBI-DataVizzle/pbi_content) | MIT |
| `worlddata-human-development` | [jurgenfolz/WorldDataReport](https://github.com/jurgenfolz/WorldDataReport) | MIT |
| `fuam-tenant-setting-enabled-security-groups` | [microsoft/fabric-toolbox](https://github.com/microsoft/fabric-toolbox) | MIT |
| `fuam-widely-shared-objects` | [microsoft/fabric-toolbox](https://github.com/microsoft/fabric-toolbox) | MIT |
| `sales-overview`, `sales-product-performance`, `sales-explore` | A local sample report | unspecified |

Only permissively licensed sources were harvested. Repositories with no licence, or a licence GitHub
could not identify, were left alone - "public" is not the same as "reusable".

The three `sales-*` layouts came from a report on the author's machine with no stated licence. They
are kept because the structures are useful and carry nothing but geometry, but the provenance is
recorded as unspecified rather than guessed at.

## Adding your own

```
harvest_layout  reportPath: "...Report", save: true, attribution: { repository: "...", license: "..." }
```

Fill in `attribution` when the report is not yours.

## What makes a layout worth keeping

Most pages in a real report do not translate. Of 28 usable public pages, 24 were rejected because
most of their slots repeated a role - a page with seven line charts is showing seven different
things, and this generator has one field assignment to give it. Filling all seven would produce the
same chart seven times.

The filter that survived: 4-13 slots, at least two chart slots, at least three distinct roles, snap
drift under 60px, and at least 70% of slots holding a distinct role.
