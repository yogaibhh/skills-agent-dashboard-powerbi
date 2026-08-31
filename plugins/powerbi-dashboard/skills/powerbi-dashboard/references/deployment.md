# Deployment and model binding

## The model reference: `definition.pbir`

The single file that decides which semantic model the report reads. Two shapes, and picking the wrong
one is the most common deployment failure.

### `byPath` - local PBIP development

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json",
  "version": "4.0",
  "datasetReference": {
    "byPath": {
      "path": "../Sales.SemanticModel"
    }
  }
}
```

The path is **relative to the `.Report` folder** and points at the semantic model folder. Use this
while developing locally and opening the `.pbip` in Power BI Desktop.

### `byConnection` - workspace deployment

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json",
  "version": "4.0",
  "datasetReference": {
    "byConnection": {
      "connectionString": "semanticmodelid=[SemanticModelId]"
    }
  }
}
```

**Required for deploying to a Fabric workspace.** A report published with `byPath` fails - the service
has no local filesystem to resolve it against.

## Opening locally in Power BI Desktop

```powershell
Start-Process "C:\path\to\Sales Overview.pbip"
```

Desktop opens the report bound to the local model. This is the fastest visual check that your
generated JSON is correct - a broken binding shows as an empty visual with an error banner, and a
malformed `visual.json` shows as a visual that fails to load.

Requires the PBIP preview feature: *File > Options and settings > Options > Preview features >
Power BI Project (.pbip) save option*.

## Deploying to a Fabric workspace

### With Fabric CLI (recommended)

Use the `fabric-cli` skill for the details; the shape is:

```bash
fab auth login
fab ls /                                          # list workspaces
fab import "/MyWorkspace.Workspace/Sales Overview.Report" -i "C:\path\to\Sales Overview.Report"
```

Before importing:

1. Find the target semantic model's ID in the workspace.
2. Rewrite `definition.pbir` to `byConnection` with that ID.
3. Import.

To deploy under a different name, change the target item name in the import path and the
`displayName` in `.platform`.

### With the Fabric REST API

`POST /v1/workspaces/{workspaceId}/items` (or `POST .../reports/{reportId}/updateDefinition`) with each
PBIR file base64-encoded as a `part`:

```json
{
  "displayName": "Sales Overview",
  "type": "Report",
  "definition": {
    "parts": [
      { "path": "definition.pbir",                 "payload": "[base64]", "payloadType": "InlineBase64" },
      { "path": "definition/report.json",          "payload": "[base64]", "payloadType": "InlineBase64" },
      { "path": "definition/version.json",         "payload": "[base64]", "payloadType": "InlineBase64" },
      { "path": "definition/pages/pages.json",     "payload": "[base64]", "payloadType": "InlineBase64" },
      { "path": "definition/pages/overview/page.json", "payload": "[base64]", "payloadType": "InlineBase64" }
    ]
  }
}
```

Every file under the `.Report` folder must be included, with `path` relative to that folder and forward
slashes. Omitting one produces a report that imports but will not open.

## Exporting an existing report to edit it

```bash
fab export "/MyWorkspace.Workspace/Existing Report.Report" -o "C:\local\folder"
```

The export lands as a `.Report` folder with a `definition/` subfolder. Run the validator on it before
editing so you know the baseline state.

## Verifying a deployment

1. The item appears in the workspace with the expected name.
2. It opens without an error banner.
3. Visuals render data, not "can't display this visual" - that message means a field reference does not
   resolve against the connected model.
4. Slicers filter the other visuals.

If visuals are empty but the report opens, the binding is wrong, not the layout: re-run
`validate-pbir.ps1 -ModelPath ...` against the model you actually connected to.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Import rejected | `definition.pbir` uses `byPath` | Switch to `byConnection` |
| Report opens, all visuals empty | `Entity`/`Property` do not match the model | Re-run the validator against the deployed model |
| One visual shows an error | Malformed `visual.json` or an invalid `filterConfig` | Validate the JSON; remove the `filterConfig` and re-test |
| Pages missing after import | A `page.json` was not included in the parts list | Include every file under `.Report` |
| Page renders but is blank | The page `name` is not listed in `pages.json` -> `pageOrder` | Add it |
| Desktop will not open the `.pbip` | PBIP preview feature is off | Enable it in Options > Preview features |
