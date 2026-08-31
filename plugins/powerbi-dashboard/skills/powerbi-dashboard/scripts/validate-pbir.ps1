<#
.SYNOPSIS
    Validate a PBIR report folder before opening or deploying it.

.DESCRIPTION
    Checks structure, JSON validity, page indexing, visual bindings, geometry, and - when -ModelPath is
    supplied - that every field reference resolves against the semantic model's TMDL.

    Errors mean the report is broken and must be fixed. Warnings mean it will open but probably looks
    or reads badly.

.PARAMETER ReportPath
    Path to the *.Report folder (the one containing definition.pbir and definition\).

.PARAMETER ModelPath
    Optional. Path to the *.SemanticModel folder (or any folder containing TMDL files). Enables field
    reference checking.

.PARAMETER FailOnWarning
    Exit with code 1 when warnings are present, not just errors.

.EXAMPLE
    .\validate-pbir.ps1 -ReportPath "C:\pbi\Sales Overview.Report" -ModelPath "C:\pbi\Sales.SemanticModel"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $ReportPath,

    [string] $ModelPath,

    [switch] $FailOnWarning
)

$ErrorActionPreference = 'Stop'

$findings = New-Object System.Collections.ArrayList

function Add-Finding {
    param(
        [ValidateSet('Error', 'Warning', 'Info')] [string] $Severity,
        [string] $Rule,
        [string] $Where,
        [string] $Message
    )
    [void]$findings.Add([PSCustomObject]@{
        Severity = $Severity
        Rule     = $Rule
        Where    = $Where
        Message  = $Message
    })
}

function Read-JsonFile {
    param([string] $Path, [string] $Label)
    try {
        $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
        if ([string]::IsNullOrWhiteSpace($raw)) {
            Add-Finding Error 'json-empty' $Label 'File is empty.'
            return $null
        }
        return $raw | ConvertFrom-Json
    }
    catch {
        Add-Finding Error 'json-invalid' $Label "Not valid JSON: $($_.Exception.Message)"
        return $null
    }
}

# ---------------------------------------------------------------------------------------------
# Structure
# ---------------------------------------------------------------------------------------------

if (-not (Test-Path -LiteralPath $ReportPath)) {
    Write-Host "Report path not found: $ReportPath" -ForegroundColor Red
    exit 1
}
$ReportPath = (Resolve-Path -LiteralPath $ReportPath).Path
$reportName = Split-Path $ReportPath -Leaf

$definitionDir = Join-Path $ReportPath 'definition'
$pagesDir      = Join-Path $definitionDir 'pages'

$requiredFiles = @(
    @{ Path = Join-Path $ReportPath 'definition.pbir';   Label = 'definition.pbir' },
    @{ Path = Join-Path $definitionDir 'report.json';    Label = 'definition/report.json' },
    @{ Path = Join-Path $definitionDir 'version.json';   Label = 'definition/version.json' },
    @{ Path = Join-Path $pagesDir 'pages.json';          Label = 'definition/pages/pages.json' }
)

foreach ($rf in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $rf.Path)) {
        Add-Finding Error 'missing-file' $rf.Label 'Required file is missing.'
    }
}

# ---------------------------------------------------------------------------------------------
# Model binding
# ---------------------------------------------------------------------------------------------

$pbirPath = Join-Path $ReportPath 'definition.pbir'
$bindingKind = $null
if (Test-Path -LiteralPath $pbirPath) {
    $pbir = Read-JsonFile $pbirPath 'definition.pbir'
    if ($null -ne $pbir) {
        $ref = $pbir.datasetReference
        if ($null -eq $ref) {
            Add-Finding Error 'binding-missing' 'definition.pbir' 'No datasetReference. The report is not bound to a semantic model.'
        }
        elseif ($null -ne $ref.byPath -and -not [string]::IsNullOrWhiteSpace($ref.byPath.path)) {
            $bindingKind = 'byPath'
            $resolved = Join-Path $ReportPath $ref.byPath.path
            if (-not (Test-Path -LiteralPath $resolved)) {
                Add-Finding Error 'binding-broken' 'definition.pbir' "byPath target does not exist: $($ref.byPath.path)"
            }
        }
        elseif ($null -ne $ref.byConnection -and -not [string]::IsNullOrWhiteSpace($ref.byConnection.connectionString)) {
            $bindingKind = 'byConnection'
        }
        else {
            Add-Finding Error 'binding-missing' 'definition.pbir' 'datasetReference has neither a usable byPath nor byConnection.'
        }
    }
}

# ---------------------------------------------------------------------------------------------
# Semantic model inventory (TMDL)
# ---------------------------------------------------------------------------------------------

$model = @{}   # table name -> @{ Columns = HashSet; Measures = HashSet }

if ($ModelPath) {
    if (-not (Test-Path -LiteralPath $ModelPath)) {
        Add-Finding Warning 'model-missing' 'ModelPath' "Semantic model path not found: $ModelPath. Field references were not checked."
        $ModelPath = $null
    }
    else {
        $tmdlFiles = Get-ChildItem -LiteralPath $ModelPath -Recurse -Filter '*.tmdl' -File -ErrorAction SilentlyContinue
        if (-not $tmdlFiles -or $tmdlFiles.Count -eq 0) {
            Add-Finding Warning 'model-empty' 'ModelPath' 'No .tmdl files found. Field references were not checked.'
            $ModelPath = $null
        }
        else {
            foreach ($file in $tmdlFiles) {
                $currentTable = $null
                foreach ($line in (Get-Content -LiteralPath $file.FullName -Encoding UTF8)) {
                    if ($line -match "^\s*table\s+(?<n>'[^']+'|[^\s=]+)\s*$") {
                        $currentTable = $Matches['n'].Trim("'")
                        if (-not $model.ContainsKey($currentTable)) {
                            $model[$currentTable] = @{
                                Columns  = New-Object System.Collections.Generic.HashSet[string]
                                Measures = New-Object System.Collections.Generic.HashSet[string]
                            }
                        }
                        continue
                    }
                    if ($null -eq $currentTable) { continue }

                    if ($line -match "^\s+measure\s+(?<n>'[^']+'|[^\s=]+)\s*(=|$)") {
                        [void]$model[$currentTable].Measures.Add($Matches['n'].Trim("'"))
                    }
                    elseif ($line -match "^\s+column\s+(?<n>'[^']+'|[^\s=]+)\s*(=|$)") {
                        [void]$model[$currentTable].Columns.Add($Matches['n'].Trim("'"))
                    }
                }
            }
            Add-Finding Info 'model-loaded' 'ModelPath' "Loaded $($model.Count) table(s) from TMDL."
        }
    }
}

# ---------------------------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------------------------

$declaredPages = @()
$activePage    = $null
$pagesJsonPath = Join-Path $pagesDir 'pages.json'

if (Test-Path -LiteralPath $pagesJsonPath) {
    $pagesMeta = Read-JsonFile $pagesJsonPath 'definition/pages/pages.json'
    if ($null -ne $pagesMeta) {
        $declaredPages = @($pagesMeta.pageOrder)
        $activePage    = $pagesMeta.activePageName
        if ($declaredPages.Count -eq 0) {
            Add-Finding Error 'pages-empty' 'pages.json' 'pageOrder is empty - the report has no pages.'
        }
        if ([string]::IsNullOrWhiteSpace($activePage)) {
            Add-Finding Warning 'active-page-missing' 'pages.json' 'activePageName is not set.'
        }
        elseif ($declaredPages -notcontains $activePage) {
            Add-Finding Error 'active-page-orphan' 'pages.json' "activePageName '$activePage' is not in pageOrder."
        }
    }
}

$noQueryTypes = @('textbox', 'image', 'shape', 'basicShape', 'actionButton', 'blank')
$allVisualNames = @{}
$fieldRefs = New-Object System.Collections.ArrayList
$foundPageNames = @()
$visualCount = 0

if (Test-Path -LiteralPath $pagesDir) {
    foreach ($pageDir in (Get-ChildItem -LiteralPath $pagesDir -Directory | Sort-Object Name)) {
        $pageLabel = "pages/$($pageDir.Name)"
        $pageJsonPath = Join-Path $pageDir.FullName 'page.json'

        if (-not (Test-Path -LiteralPath $pageJsonPath)) {
            Add-Finding Error 'page-missing-json' $pageLabel 'Folder has no page.json.'
            continue
        }

        $page = Read-JsonFile $pageJsonPath "$pageLabel/page.json"
        if ($null -eq $page) { continue }

        if ([string]::IsNullOrWhiteSpace($page.name)) {
            Add-Finding Error 'page-no-name' $pageLabel 'page.json has no name property.'
            continue
        }
        $foundPageNames += $page.name

        if ($declaredPages -notcontains $page.name) {
            Add-Finding Error 'page-not-indexed' $pageLabel "Page name '$($page.name)' is not listed in pages.json -> pageOrder. The page will not render."
        }

        $pageWidth  = 1280
        $pageHeight = 720
        if ($page.width)  { $pageWidth  = [double]$page.width }
        if ($page.height) { $pageHeight = [double]$page.height }

        # --- visuals on this page ---
        $visualsDir = Join-Path $pageDir.FullName 'visuals'
        $rects = @()

        if (-not (Test-Path -LiteralPath $visualsDir)) {
            Add-Finding Warning 'page-empty' $pageLabel 'Page has no visuals folder - it will render blank.'
            continue
        }

        $visualDirs = @(Get-ChildItem -LiteralPath $visualsDir -Directory)
        if ($visualDirs.Count -eq 0) {
            Add-Finding Warning 'page-empty' $pageLabel 'Page has no visuals - it will render blank.'
            continue
        }

        foreach ($vDir in ($visualDirs | Sort-Object Name)) {
            $vLabel = "$pageLabel/visuals/$($vDir.Name)"
            $vPath  = Join-Path $vDir.FullName 'visual.json'

            if (-not (Test-Path -LiteralPath $vPath)) {
                Add-Finding Error 'visual-missing-json' $vLabel 'Folder has no visual.json.'
                continue
            }

            $v = Read-JsonFile $vPath "$vLabel/visual.json"
            if ($null -eq $v) { continue }
            $visualCount++

            if ([string]::IsNullOrWhiteSpace($v.name)) {
                Add-Finding Error 'visual-no-name' $vLabel 'visual.json has no name property.'
            }
            elseif ($allVisualNames.ContainsKey($v.name)) {
                Add-Finding Error 'visual-duplicate-name' $vLabel "Duplicate name '$($v.name)' - also used by $($allVisualNames[$v.name])."
            }
            else {
                $allVisualNames[$v.name] = $vLabel
            }

            $type = $null
            if ($v.visual) { $type = $v.visual.visualType }
            if ([string]::IsNullOrWhiteSpace($type)) {
                Add-Finding Error 'visual-no-type' $vLabel 'visual.visualType is missing.'
            }

            # --- geometry ---
            $p = $v.position
            if ($null -eq $p) {
                Add-Finding Error 'visual-no-position' $vLabel 'position is missing.'
            }
            else {
                $x = [double]$p.x; $y = [double]$p.y
                $w = [double]$p.width; $h = [double]$p.height

                if ($w -le 0 -or $h -le 0) {
                    Add-Finding Error 'visual-zero-size' $vLabel "width/height must be positive (got $w x $h)."
                }
                if ($x -lt -0.5 -or $y -lt -0.5) {
                    Add-Finding Warning 'visual-negative-origin' $vLabel "Visual starts off-canvas at ($x, $y)."
                }
                if (($x + $w) -gt ($pageWidth + 0.5) -or ($y + $h) -gt ($pageHeight + 0.5)) {
                    Add-Finding Warning 'visual-out-of-bounds' $vLabel ("Extends past the {0}x{1} canvas (ends at {2}, {3})." -f $pageWidth, $pageHeight, [math]::Round($x + $w, 1), [math]::Round($y + $h, 1))
                }

                $rects += [PSCustomObject]@{ Label = $vLabel; X = $x; Y = $y; W = $w; H = $h }
            }

            # --- binding ---
            $hasProjection = $false
            $queryState = $null
            if ($v.visual -and $v.visual.query) { $queryState = $v.visual.query.queryState }
            if ($null -ne $queryState) {
                foreach ($role in $queryState.PSObject.Properties) {
                    $projections = $role.Value.projections
                    if ($projections -and @($projections).Count -gt 0) { $hasProjection = $true }
                }
            }

            if (-not $hasProjection -and $type -and ($noQueryTypes -notcontains $type)) {
                Add-Finding Error 'visual-unbound' $vLabel "'$type' has no field bindings - it will render as an empty placeholder."
            }

            # --- collect field references ---
            $stack = New-Object System.Collections.Stack
            $stack.Push($v)
            while ($stack.Count -gt 0) {
                $node = $stack.Pop()
                if ($null -eq $node) { continue }

                if ($node -is [System.Collections.IEnumerable] -and $node -isnot [string]) {
                    foreach ($item in $node) { $stack.Push($item) }
                    continue
                }
                if ($node -isnot [PSCustomObject]) { continue }

                foreach ($prop in $node.PSObject.Properties) {
                    if (($prop.Name -eq 'Measure' -or $prop.Name -eq 'Column') -and $prop.Value -is [PSCustomObject]) {
                        $entity = $null
                        if ($prop.Value.Expression -and $prop.Value.Expression.SourceRef) {
                            $entity = $prop.Value.Expression.SourceRef.Entity
                        }
                        if ($entity -and $prop.Value.Property) {
                            [void]$fieldRefs.Add([PSCustomObject]@{
                                Where    = $vLabel
                                Kind     = $prop.Name
                                Entity   = $entity
                                Property = $prop.Value.Property
                            })
                        }
                    }
                    $stack.Push($prop.Value)
                }
            }
        }

        # --- overlap detection (1px tolerance so adjacent visuals do not trip it) ---
        for ($i = 0; $i -lt $rects.Count; $i++) {
            for ($j = $i + 1; $j -lt $rects.Count; $j++) {
                $a = $rects[$i]; $b = $rects[$j]
                $overlapX = [math]::Min($a.X + $a.W, $b.X + $b.W) - [math]::Max($a.X, $b.X)
                $overlapY = [math]::Min($a.Y + $a.H, $b.Y + $b.H) - [math]::Max($a.Y, $b.Y)
                if ($overlapX -gt 1 -and $overlapY -gt 1) {
                    Add-Finding Warning 'visual-overlap' $a.Label ("Overlaps '{0}' by {1}x{2} px." -f (Split-Path $b.Label -Leaf), [math]::Round($overlapX, 0), [math]::Round($overlapY, 0))
                }
            }
        }
    }
}

# pages declared but not present on disk
foreach ($declared in $declaredPages) {
    if ($foundPageNames -notcontains $declared) {
        Add-Finding Error 'page-orphan-index' 'pages.json' "pageOrder lists '$declared' but no page.json on disk carries that name."
    }
}

# ---------------------------------------------------------------------------------------------
# Field references vs model
# ---------------------------------------------------------------------------------------------

if ($ModelPath -and $model.Count -gt 0) {
    $reported = New-Object System.Collections.Generic.HashSet[string]

    foreach ($fr in $fieldRefs) {
        $key = "$($fr.Where)|$($fr.Entity)|$($fr.Property)"
        if (-not $reported.Add($key)) { continue }

        # -ceq: PowerShell's -eq is case-insensitive, which would hide case mismatches.
        $tableKey = $model.Keys | Where-Object { $_ -ceq $fr.Entity } | Select-Object -First 1
        if (-not $tableKey) {
            $ciTable = $model.Keys | Where-Object { $_ -ieq $fr.Entity } | Select-Object -First 1
            if ($ciTable) {
                Add-Finding Warning 'ref-table-case' $fr.Where "Entity '$($fr.Entity)' differs in case from the model's '$ciTable'."
                $tableKey = $ciTable
            }
            else {
                Add-Finding Error 'ref-table-missing' $fr.Where "Table '$($fr.Entity)' does not exist in the semantic model."
                continue
            }
        }

        if ($fr.Kind -eq 'Measure') { $pool = $model[$tableKey].Measures } else { $pool = $model[$tableKey].Columns }

        if (-not $pool.Contains($fr.Property)) {
            $ciMatch = $pool | Where-Object { $_ -ieq $fr.Property } | Select-Object -First 1
            if ($ciMatch) {
                Add-Finding Warning 'ref-field-case' $fr.Where "$($fr.Kind) '$($fr.Entity)'[$($fr.Property)] differs in case from the model's '$ciMatch'."
            }
            else {
                Add-Finding Error 'ref-field-missing' $fr.Where "$($fr.Kind) '$($fr.Property)' does not exist on table '$tableKey'."
            }
        }
    }
}

# ---------------------------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------------------------

$errors   = @($findings | Where-Object { $_.Severity -eq 'Error' })
$warnings = @($findings | Where-Object { $_.Severity -eq 'Warning' })
$infos    = @($findings | Where-Object { $_.Severity -eq 'Info' })

Write-Host ''
Write-Host "PBIR validation - $reportName" -ForegroundColor Cyan
Write-Host ("  pages: {0}   visuals: {1}   field refs: {2}   binding: {3}" -f $foundPageNames.Count, $visualCount, $fieldRefs.Count, $(if ($bindingKind) { $bindingKind } else { 'unknown' }))
Write-Host ''

foreach ($group in @(
    @{ Items = $errors;   Color = 'Red';    Tag = 'ERROR' },
    @{ Items = $warnings; Color = 'Yellow'; Tag = 'WARN ' },
    @{ Items = $infos;    Color = 'Gray';   Tag = 'INFO ' }
)) {
    foreach ($f in $group.Items) {
        Write-Host ("  [{0}] {1,-24} {2}" -f $group.Tag, $f.Rule, $f.Where) -ForegroundColor $group.Color
        Write-Host ("          {0}" -f $f.Message)
    }
}

Write-Host ''
if ($errors.Count -eq 0 -and $warnings.Count -eq 0) {
    Write-Host '  No issues found.' -ForegroundColor Green
}
else {
    Write-Host ("  {0} error(s), {1} warning(s)." -f $errors.Count, $warnings.Count) -ForegroundColor $(if ($errors.Count -gt 0) { 'Red' } else { 'Yellow' })
}
Write-Host ''

if ($errors.Count -gt 0) { exit 1 }
if ($FailOnWarning -and $warnings.Count -gt 0) { exit 1 }
exit 0
