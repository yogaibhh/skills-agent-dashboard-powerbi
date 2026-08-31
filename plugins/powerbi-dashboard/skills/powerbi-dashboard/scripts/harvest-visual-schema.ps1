<#
.SYNOPSIS
    Extract the real PBIR schema of every visual type found in a set of reports.

.DESCRIPTION
    Walks one or more folders for visual.json files and aggregates, per visualType:

      - which queryState roles appear, how often, and whether they carry Measures or Columns
      - how many projections each role was seen holding
      - which objects / visualContainerObjects formatting groups are used
      - a representative queryState example, taken from the richest instance found
      - visual-level filterConfig bodies, grouped by filter type

    This replaces guessing. Author the visuals you care about once in Power BI Desktop, save as PBIP,
    point this script at the folder, and the output is a verified catalog entry you can paste into
    references/visual-catalog.md - including the filterConfig shapes that are impractical to write by
    hand.

.PARAMETER Path
    One or more folders to scan. Searched recursively for visual.json, so a PBIP project root, a
    .Report folder, or a folder holding many reports all work.

.PARAMETER OutputPath
    Folder to write results into. Defaults to the current directory. Produces visual-schema.md and
    visual-schema.json depending on -Format.

.PARAMETER Format
    md, json, or both (default).

.PARAMETER MaxExampleChars
    Skip an example whose JSON exceeds this length, to keep the report readable. Default 4000.

.EXAMPLE
    .\harvest-visual-schema.ps1 -Path "C:\pbi\VisualZoo.Report" -OutputPath ".\out"

.EXAMPLE
    .\harvest-visual-schema.ps1 -Path "C:\pbi\reports","C:\pbi\more-reports" -Format md
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]] $Path,

    [string] $OutputPath = '.',

    [ValidateSet('md', 'json', 'both')]
    [string] $Format = 'both',

    [int] $MaxExampleChars = 4000
)

$ErrorActionPreference = 'Stop'

function Write-Utf8NoBom {
    # PBIR files that Power BI writes carry no byte-order mark; Set-Content -Encoding utf8 adds one
    # under Windows PowerShell 5.1. Match the format exactly instead.
    param([string] $Path, [string] $Content)
    $full = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    [System.IO.File]::WriteAllText($full, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

# ---------------------------------------------------------------------------------------------
# Collect visual.json files
# ---------------------------------------------------------------------------------------------

$files = @()
foreach ($p in $Path) {
    if (-not (Test-Path -LiteralPath $p)) {
        Write-Warning "Path not found, skipping: $p"
        continue
    }
    $resolved = (Resolve-Path -LiteralPath $p).Path
    $files += Get-ChildItem -LiteralPath $resolved -Recurse -Filter 'visual.json' -File -ErrorAction SilentlyContinue
}

$files = @($files | Sort-Object FullName -Unique)

if ($files.Count -eq 0) {
    throw "No visual.json files found under: $($Path -join ', ')"
}

Write-Host "Scanning $($files.Count) visual.json file(s)..." -ForegroundColor Cyan

# ---------------------------------------------------------------------------------------------
# Aggregate
# ---------------------------------------------------------------------------------------------

# visualType -> aggregate
$types = @{}
# filter type -> aggregate
$filters = @{}
$skipped = 0

function Get-NewTypeEntry {
    return [PSCustomObject]@{
        VisualType      = ''
        Count           = 0
        Sources         = New-Object System.Collections.Generic.HashSet[string]
        Roles           = @{}   # role -> @{ Count; Kinds(HashSet); MaxFields; ActiveSeen }
        Objects         = @{}   # group name -> count
        ContainerObjects= @{}   # group name -> count
        SortSeen        = 0
        FilterSeen      = 0
        BestScore       = -1
        BestExample     = $null
        BestSource      = ''
    }
}

foreach ($file in $files) {
    try { $v = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { $skipped++; continue }

    if ($null -eq $v.visual -or [string]::IsNullOrWhiteSpace($v.visual.visualType)) { $skipped++; continue }

    $type = [string]$v.visual.visualType
    if (-not $types.ContainsKey($type)) {
        $entry = Get-NewTypeEntry
        $entry.VisualType = $type
        $types[$type] = $entry
    }
    $t = $types[$type]
    $t.Count++

    # Which report this came from: prefer an ancestor named *.Report; otherwise the folder holding
    # 'definition', which is the report root whatever it happens to be called.
    $source = $null
    $probe = $file.Directory
    while ($null -ne $probe) {
        if ($probe.Name -like '*.Report') { $source = $probe.Name; break }
        if ($probe.Name -eq 'definition' -and $null -ne $probe.Parent) { $source = $probe.Parent.Name; break }
        $probe = $probe.Parent
    }
    if ([string]::IsNullOrWhiteSpace($source)) { $source = $file.Directory.Name }
    [void]$t.Sources.Add($source)

    # --- roles ---
    $queryState = $null
    if ($v.visual.query) { $queryState = $v.visual.query.queryState }

    $roleCount = 0
    $fieldCount = 0

    if ($null -ne $queryState) {
        foreach ($role in $queryState.PSObject.Properties) {
            $roleName = $role.Name
            $projections = @($role.Value.projections)
            if ($projections.Count -eq 0) { continue }
            $roleCount++

            if (-not $t.Roles.ContainsKey($roleName)) {
                $t.Roles[$roleName] = [PSCustomObject]@{
                    Count      = 0
                    Kinds      = New-Object System.Collections.Generic.HashSet[string]
                    MaxFields  = 0
                    ActiveSeen = $false
                }
            }
            $r = $t.Roles[$roleName]
            $r.Count++
            if ($projections.Count -gt $r.MaxFields) { $r.MaxFields = $projections.Count }

            foreach ($proj in $projections) {
                if ($null -eq $proj) { continue }
                $fieldCount++
                if ($null -ne $proj.active) { $r.ActiveSeen = $true }
                if ($null -eq $proj.field) { continue }
                foreach ($kindProp in $proj.field.PSObject.Properties) {
                    [void]$r.Kinds.Add($kindProp.Name)
                }
            }
        }
    }

    # --- formatting groups ---
    if ($v.visual.objects) {
        foreach ($g in $v.visual.objects.PSObject.Properties) {
            if (-not $t.Objects.ContainsKey($g.Name)) { $t.Objects[$g.Name] = 0 }
            $t.Objects[$g.Name]++
        }
    }
    if ($v.visual.visualContainerObjects) {
        foreach ($g in $v.visual.visualContainerObjects.PSObject.Properties) {
            if (-not $t.ContainerObjects.ContainsKey($g.Name)) { $t.ContainerObjects[$g.Name] = 0 }
            $t.ContainerObjects[$g.Name]++
        }
    }

    if ($v.visual.sortDefinition) { $t.SortSeen++ }

    # --- filters ---
    $filterConfig = $null
    if ($v.filterConfig) { $filterConfig = $v.filterConfig }
    elseif ($v.visual.filterConfig) { $filterConfig = $v.visual.filterConfig }

    if ($null -ne $filterConfig) {
        $t.FilterSeen++
        foreach ($f in @($filterConfig.filters)) {
            if ($null -eq $f) { continue }
            $ftype = 'Unspecified'
            if ($f.type) { $ftype = [string]$f.type }
            if (-not $filters.ContainsKey($ftype)) {
                $filters[$ftype] = [PSCustomObject]@{
                    Type    = $ftype
                    Count   = 0
                    Example = $null
                    Source  = ''
                }
            }
            $filters[$ftype].Count++
            if ($null -eq $filters[$ftype].Example) {
                $filters[$ftype].Example = $f
                $filters[$ftype].Source  = $source
            }
        }
    }

    # --- keep the richest instance as the example ---
    $score = ($roleCount * 100) + $fieldCount
    if ($score -gt $t.BestScore -and $roleCount -gt 0) {
        $t.BestScore   = $score
        $t.BestExample = $queryState
        $t.BestSource  = $source
    }
}

# ---------------------------------------------------------------------------------------------
# Emit
# ---------------------------------------------------------------------------------------------

if (-not (Test-Path -LiteralPath $OutputPath)) {
    New-Item -ItemType Directory -Path $OutputPath -Force | Out-Null
}
$OutputPath = (Resolve-Path -LiteralPath $OutputPath).Path

$ordered = @($types.Values | Sort-Object @{ Expression = { $_.Count }; Descending = $true }, @{ Expression = { $_.VisualType } })
$written = @()

# --- JSON ---
if ($Format -eq 'json' -or $Format -eq 'both') {
    $payload = [PSCustomObject]@{
        generatedUtc = (Get-Date).ToUniversalTime().ToString('s') + 'Z'
        scannedFiles = $files.Count
        skippedFiles = $skipped
        visualTypes  = @(
            foreach ($t in $ordered) {
                [PSCustomObject]@{
                    visualType = $t.VisualType
                    count      = $t.Count
                    sources    = @($t.Sources)
                    roles      = @(
                        foreach ($k in ($t.Roles.Keys | Sort-Object)) {
                            [PSCustomObject]@{
                                role       = $k
                                count      = $t.Roles[$k].Count
                                fieldKinds = @($t.Roles[$k].Kinds)
                                maxFields  = $t.Roles[$k].MaxFields
                                usesActive = $t.Roles[$k].ActiveSeen
                            }
                        }
                    )
                    objects          = @($t.Objects.Keys | Sort-Object)
                    containerObjects = @($t.ContainerObjects.Keys | Sort-Object)
                    sortDefinitionSeen = $t.SortSeen
                    filterConfigSeen   = $t.FilterSeen
                    exampleQueryState  = $t.BestExample
                }
            }
        )
        filterTypes = @(
            foreach ($k in ($filters.Keys | Sort-Object)) {
                [PSCustomObject]@{
                    type    = $k
                    count   = $filters[$k].Count
                    source  = $filters[$k].Source
                    example = $filters[$k].Example
                }
            }
        )
    }

    $jsonPath = Join-Path $OutputPath 'visual-schema.json'
    Write-Utf8NoBom -Path $jsonPath -Content ($payload | ConvertTo-Json -Depth 60)
    $written += $jsonPath
}

# --- Markdown ---
if ($Format -eq 'md' -or $Format -eq 'both') {
    $sb = New-Object System.Text.StringBuilder
    function Add-Md { param([string] $Text = '') [void]$sb.AppendLine($Text) }

    Add-Md '# Harvested visual schema'
    Add-Md ''
    Add-Md ("Generated {0} from {1} visual.json file(s) across {2} visual type(s)." -f
        (Get-Date).ToString('yyyy-MM-dd HH:mm'), $files.Count, $ordered.Count)
    if ($skipped -gt 0) { Add-Md ("{0} file(s) skipped (unreadable, or no visualType)." -f $skipped) }
    Add-Md ''
    Add-Md 'Everything below was observed in real reports - none of it is inferred. Paste entries into'
    Add-Md '`references/visual-catalog.md` to promote a type from "verify before use" to confirmed.'
    Add-Md ''

    Add-Md '## Summary'
    Add-Md ''
    Add-Md '| visualType | seen | roles |'
    Add-Md '| --- | --- | --- |'
    foreach ($t in $ordered) {
        $roleList = ($t.Roles.Keys | Sort-Object) -join ', '
        if ([string]::IsNullOrWhiteSpace($roleList)) { $roleList = '_none_' }
        Add-Md ("| ``{0}`` | {1} | {2} |" -f $t.VisualType, $t.Count, $roleList)
    }
    Add-Md ''

    foreach ($t in $ordered) {
        Add-Md ("## ``{0}``" -f $t.VisualType)
        Add-Md ''
        Add-Md ("Seen {0} time(s) in: {1}" -f $t.Count, (@($t.Sources) -join ', '))
        Add-Md ''

        if ($t.Roles.Count -gt 0) {
            Add-Md '| Role | Seen | Field kinds | Max fields | Uses `active` |'
            Add-Md '| --- | --- | --- | --- | --- |'
            foreach ($k in ($t.Roles.Keys | Sort-Object)) {
                $r = $t.Roles[$k]
                $kinds = (@($r.Kinds) | Sort-Object) -join ', '
                if ([string]::IsNullOrWhiteSpace($kinds)) { $kinds = '-' }
                Add-Md ("| ``{0}`` | {1} | {2} | {3} | {4} |" -f $k, $r.Count, $kinds, $r.MaxFields, $(if ($r.ActiveSeen) { 'yes' } else { 'no' }))
            }
        }
        else {
            Add-Md 'No query roles observed - this type carries no field bindings.'
        }
        Add-Md ''

        if ($t.Objects.Count -gt 0) {
            $groups = ($t.Objects.Keys | Sort-Object | ForEach-Object { "``$_`` ($($t.Objects[$_]))" }) -join ', '
            Add-Md ("**objects** groups: {0}" -f $groups)
            Add-Md ''
        }
        if ($t.ContainerObjects.Count -gt 0) {
            $groups = ($t.ContainerObjects.Keys | Sort-Object | ForEach-Object { "``$_`` ($($t.ContainerObjects[$_]))" }) -join ', '
            Add-Md ("**visualContainerObjects** groups: {0}" -f $groups)
            Add-Md ''
        }
        if ($t.SortSeen -gt 0)   { Add-Md ("`sortDefinition` present in {0} of {1}." -f $t.SortSeen, $t.Count); Add-Md '' }
        if ($t.FilterSeen -gt 0) { Add-Md ("`filterConfig` present in {0} of {1}." -f $t.FilterSeen, $t.Count); Add-Md '' }

        if ($null -ne $t.BestExample) {
            $json = $t.BestExample | ConvertTo-Json -Depth 40
            if ($json.Length -le $MaxExampleChars) {
                Add-Md ("Richest ``queryState`` observed (from {0}):" -f $t.BestSource)
                Add-Md ''
                Add-Md '```json'
                Add-Md $json
                Add-Md '```'
            }
            else {
                Add-Md ("_Example omitted: {0} chars exceeds -MaxExampleChars ({1}). Read it from visual-schema.json._" -f $json.Length, $MaxExampleChars)
            }
            Add-Md ''
        }
    }

    if ($filters.Count -gt 0) {
        Add-Md '## Filters'
        Add-Md ''
        Add-Md 'Visual-level `filterConfig` bodies, one representative example per filter type. These are'
        Add-Md 'the shapes that are impractical to hand-write - copy them verbatim.'
        Add-Md ''
        foreach ($k in ($filters.Keys | Sort-Object)) {
            $f = $filters[$k]
            Add-Md ("### ``{0}``" -f $k)
            Add-Md ''
            Add-Md ("Seen {0} time(s), example from {1}:" -f $f.Count, $f.Source)
            Add-Md ''
            $json = $f.Example | ConvertTo-Json -Depth 40
            if ($json.Length -le $MaxExampleChars) {
                Add-Md '```json'
                Add-Md $json
                Add-Md '```'
            }
            else {
                Add-Md ("_Example omitted: {0} chars. Read it from visual-schema.json._" -f $json.Length)
            }
            Add-Md ''
        }
    }
    else {
        Add-Md '## Filters'
        Add-Md ''
        Add-Md 'No visual-level `filterConfig` found in the scanned reports. To harvest Top-N and other'
        Add-Md 'filter shapes, add the filters you need to a report in Power BI Desktop, save as PBIP, and'
        Add-Md 'rescan.'
        Add-Md ''
    }

    $mdPath = Join-Path $OutputPath 'visual-schema.md'
    Write-Utf8NoBom -Path $mdPath -Content $sb.ToString()
    $written += $mdPath
}

# ---------------------------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------------------------

Write-Host ''
Write-Host ("Harvested {0} visual type(s), {1} filter type(s)" -f $ordered.Count, $filters.Count) -ForegroundColor Green
foreach ($w in $written) { Write-Host "  $w" }
if ($skipped -gt 0) { Write-Host "  $skipped file(s) skipped" -ForegroundColor Yellow }
Write-Host ''

[PSCustomObject]@{
    VisualTypes = $ordered.Count
    FilterTypes = $filters.Count
    Scanned     = $files.Count
    Skipped     = $skipped
    Written     = $written
}
