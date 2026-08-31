<#
.SYNOPSIS
    Test suite for the powerbi-dashboard scripts.

.DESCRIPTION
    Self-contained: no Pester, no modules, no network. Runs on Windows PowerShell 5.1 and PowerShell 7,
    which is the same range the scripts themselves support.

    Builds fixtures in a temp folder, exercises every script, and asserts on exit codes, emitted files
    and output text. Exits 1 if any test fails.

.PARAMETER Filter
    Only run tests whose name matches this wildcard pattern.

.PARAMETER KeepWorkspace
    Leave the temp workspace behind for inspection.

.EXAMPLE
    .\run-tests.ps1

.EXAMPLE
    .\run-tests.ps1 -Filter "validate*" -KeepWorkspace
#>
[CmdletBinding()]
param(
    [string] $Filter = '*',
    [switch] $KeepWorkspace
)

$ErrorActionPreference = 'Stop'

$repoRoot   = Split-Path $PSScriptRoot -Parent
$scriptsDir = Join-Path $repoRoot 'plugins\powerbi-dashboard\skills\powerbi-dashboard\scripts'
$exampleDir = Join-Path $repoRoot 'examples\sales-overview'

$newDashboard = Join-Path $scriptsDir 'new-dashboard.ps1'
$validate     = Join-Path $scriptsDir 'validate-pbir.ps1'
$preview      = Join-Path $scriptsDir 'preview-pbir.ps1'
$harvest      = Join-Path $scriptsDir 'harvest-visual-schema.ps1'

$workspace = Join-Path ([System.IO.Path]::GetTempPath()) ("pbi-dash-tests-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $workspace -Force | Out-Null

# definition.pbir in the example binds byPath to '..\Sales.SemanticModel', so every report copied into
# the workspace needs that model as a sibling. Without it every fixture reports a broken binding and
# the exit-code assertions below would pass for the wrong reason.
Copy-Item -LiteralPath (Join-Path $exampleDir 'Sales.SemanticModel') -Destination (Join-Path $workspace 'Sales.SemanticModel') -Recurse -Force

# ---------------------------------------------------------------------------------------------
# Tiny test harness
# ---------------------------------------------------------------------------------------------

$script:passed = 0
$script:failed = 0
$script:skipped = 0
$script:failures = New-Object System.Collections.ArrayList

function Test-Case {
    param([string] $Name, [scriptblock] $Body)

    if ($Name -notlike $Filter) { $script:skipped++; return }

    try {
        & $Body
        $script:passed++
        Write-Host ("  PASS  {0}" -f $Name) -ForegroundColor Green
    }
    catch {
        $script:failed++
        [void]$script:failures.Add([PSCustomObject]@{ Name = $Name; Message = $_.Exception.Message })
        Write-Host ("  FAIL  {0}" -f $Name) -ForegroundColor Red
        Write-Host ("        {0}" -f $_.Exception.Message) -ForegroundColor DarkRed
    }
}

function Assert-True {
    param([bool] $Condition, [string] $Because)
    if (-not $Condition) { throw $Because }
}

function Assert-Equal {
    param($Expected, $Actual, [string] $Because)
    if ($Expected -ne $Actual) { throw "$Because (expected '$Expected', got '$Actual')" }
}

function Assert-Match {
    param([string] $Text, [string] $Pattern, [string] $Because)
    if ($Text -notmatch $Pattern) { throw "$Because (pattern '$Pattern' not found)" }
}

function Assert-NotMatch {
    param([string] $Text, [string] $Pattern, [string] $Because)
    if ($Text -match $Pattern) { throw "$Because (pattern '$Pattern' unexpectedly found)" }
}

function Assert-FileExists {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { throw "Expected file to exist: $Path" }
}

function Assert-NoBom {
    param([string] $Path)
    Assert-FileExists $Path
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        throw "File starts with a UTF-8 BOM, which Power BI's own PBIR files do not: $Path"
    }
}

function Invoke-Script {
    # Runs a script, returning its combined output and exit code. Scripts that never call exit
    # report the exit code of whatever ran before them, so only trust ExitCode for validate-pbir.
    param([string] $ScriptPath, [hashtable] $Arguments)
    $global:LASTEXITCODE = 0
    $output = & $ScriptPath @Arguments *>&1 | Out-String
    return [PSCustomObject]@{ Output = $output; ExitCode = $LASTEXITCODE }
}

function New-BrokenReport {
    # Copies the committed example, applies a mutation, returns the new report path.
    param([string] $Label, [scriptblock] $Mutate)
    $dest = Join-Path $workspace "$Label.Report"
    Copy-Item -LiteralPath (Join-Path $exampleDir 'Sales Overview.Report') -Destination $dest -Recurse -Force
    $visuals = Join-Path $dest 'definition\pages\overview\visuals'
    & $Mutate $dest $visuals
    return $dest
}

function Set-JsonFile {
    param([string] $Path, [string] $Content)
    [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

function Edit-JsonFile {
    param([string] $Path, [string] $Find, [string] $Replace)
    $raw = [System.IO.File]::ReadAllText($Path)
    if ($raw -notlike "*$Find*") { throw "Fixture setup failed: '$Find' not present in $Path" }
    Set-JsonFile -Path $Path -Content $raw.Replace($Find, $Replace)
}

Write-Host ''
Write-Host "powerbi-dashboard test suite" -ForegroundColor Cyan
Write-Host "  workspace: $workspace"
Write-Host "  PowerShell $($PSVersionTable.PSVersion)"
Write-Host ''

# ---------------------------------------------------------------------------------------------
# Sanity: every script parses
# ---------------------------------------------------------------------------------------------

Write-Host 'syntax' -ForegroundColor Cyan
foreach ($f in (Get-ChildItem -LiteralPath $scriptsDir -Filter '*.ps1' | Sort-Object Name)) {
    $name = $f.Name
    Test-Case "syntax: $name parses" {
        $errs = $null
        [System.Management.Automation.PSParser]::Tokenize((Get-Content -LiteralPath $f.FullName -Raw), [ref]$errs) | Out-Null
        Assert-Equal 0 $errs.Count "$name has parse errors"
    }
}

# ---------------------------------------------------------------------------------------------
# new-dashboard.ps1
# ---------------------------------------------------------------------------------------------

Write-Host ''
Write-Host 'new-dashboard' -ForegroundColor Cyan

$scaffoldRoot = Join-Path $workspace 'scaffold'
$scaffoldA = $null
$scaffoldB = $null

# A scaffold binds byPath to '..\Fixture.SemanticModel'; give it something real to resolve to.
$fixtureTables = Join-Path $scaffoldRoot 'Fixture.SemanticModel\definition\tables'
New-Item -ItemType Directory -Path $fixtureTables -Force | Out-Null
Set-JsonFile -Path (Join-Path $fixtureTables 'Fact.tmdl') -Content "table Fact`n`tmeasure 'Total' = COUNTROWS(Fact)`n`tcolumn Id`n`t`tdataType: int64`n" 

Test-Case 'new-dashboard: scaffolds report folder and pbip' {
    $script:scaffoldA = & $newDashboard -Name 'Test Alpha' -OutputPath $scaffoldRoot -ModelPath '..\Fixture.SemanticModel' 6>$null
    Assert-FileExists $script:scaffoldA.ReportPath
    Assert-FileExists $script:scaffoldA.PbipPath
    Assert-FileExists (Join-Path $script:scaffoldA.ReportPath 'definition\report.json')
    Assert-FileExists (Join-Path $script:scaffoldA.ReportPath 'definition\version.json')
    Assert-FileExists (Join-Path $script:scaffoldA.ReportPath 'StaticResources\RegisteredResources\theme.json')
}

Test-Case 'new-dashboard: .platform carries the name and a real GUID' {
    $platform = Get-Content -LiteralPath (Join-Path $script:scaffoldA.ReportPath '.platform') -Raw | ConvertFrom-Json
    Assert-Equal 'Test Alpha' $platform.metadata.displayName 'displayName not applied'
    Assert-Equal 'Report' $platform.metadata.type 'item type should be Report'
    $parsed = [guid]::Empty
    Assert-True ([guid]::TryParse($platform.config.logicalId, [ref]$parsed)) 'logicalId is not a GUID'
    Assert-True ($platform.config.logicalId -ne '00000000-0000-0000-0000-000000000000') 'logicalId was not regenerated from the template'
}

Test-Case 'new-dashboard: byPath binding points at the model' {
    $pbir = Get-Content -LiteralPath (Join-Path $script:scaffoldA.ReportPath 'definition.pbir') -Raw | ConvertFrom-Json
    Assert-Equal '..\Fixture.SemanticModel' $pbir.datasetReference.byPath.path 'byPath not applied'
    Assert-True ($null -eq $pbir.datasetReference.byConnection) 'byConnection should be absent'
}

Test-Case 'new-dashboard: page token is 20 hex chars and indexed' {
    $pages = Get-Content -LiteralPath (Join-Path $script:scaffoldA.ReportPath 'definition\pages\pages.json') -Raw | ConvertFrom-Json
    Assert-Match $script:scaffoldA.PageName '^[0-9a-f]{20}$' 'page token is not 20 hex characters'
    Assert-True ($pages.pageOrder -contains $script:scaffoldA.PageName) 'page token missing from pageOrder'
    Assert-Equal $script:scaffoldA.PageName $pages.activePageName 'activePageName does not match the page'
}

Test-Case 'new-dashboard: page names are unique across scaffolds' {
    $script:scaffoldB = & $newDashboard -Name 'Test Beta' -OutputPath $scaffoldRoot -ModelPath '..\Fixture.SemanticModel' 6>$null
    Assert-True ($script:scaffoldA.PageName -ne $script:scaffoldB.PageName) 'two scaffolds produced the same page name'
    Assert-True ($script:scaffoldA.LogicalId -ne $script:scaffoldB.LogicalId) 'two scaffolds produced the same logicalId'
}

Test-Case 'new-dashboard: byConnection writes a connection string' {
    $r = & $newDashboard -Name 'Test Conn' -OutputPath $scaffoldRoot -ByConnection '3f2b9c10-1a4d-4c8e-9f01-2b3c4d5e6f70' 6>$null
    $pbir = Get-Content -LiteralPath (Join-Path $r.ReportPath 'definition.pbir') -Raw | ConvertFrom-Json
    Assert-Equal 'semanticmodelid=3f2b9c10-1a4d-4c8e-9f01-2b3c4d5e6f70' $pbir.datasetReference.byConnection.connectionString 'connectionString not applied'
    Assert-True ($null -eq $pbir.datasetReference.byPath) 'byPath should be absent'
}

Test-Case 'new-dashboard: emits no BOM and no .gitkeep' {
    foreach ($rel in @('.platform', 'definition.pbir', 'definition\pages\pages.json', 'definition\pages\overview\page.json')) {
        Assert-NoBom (Join-Path $script:scaffoldA.ReportPath $rel)
    }
    Assert-NoBom $script:scaffoldA.PbipPath
    $keep = @(Get-ChildItem -LiteralPath $script:scaffoldA.ReportPath -Recurse -Force -Filter '.gitkeep')
    Assert-Equal 0 $keep.Count 'template .gitkeep leaked into the scaffold'
}

Test-Case 'new-dashboard: refuses to overwrite without -Force' {
    $threw = $false
    try { & $newDashboard -Name 'Test Alpha' -OutputPath $scaffoldRoot -ModelPath '..\x' 6>$null }
    catch { $threw = $true }
    Assert-True $threw 'scaffolding over an existing folder should throw without -Force'
}

Test-Case 'new-dashboard: scaffold validates clean' {
    $r = Invoke-Script $validate @{ ReportPath = $script:scaffoldB.ReportPath }
    Assert-Equal 0 $r.ExitCode 'a fresh scaffold should have no errors'
    Assert-Match $r.Output 'page-empty' 'a visual-less scaffold should warn that the page is empty'
}

# ---------------------------------------------------------------------------------------------
# validate-pbir.ps1
# ---------------------------------------------------------------------------------------------

Write-Host ''
Write-Host 'validate-pbir' -ForegroundColor Cyan

$cleanReport = Join-Path $exampleDir 'Sales Overview.Report'
$cleanModel  = Join-Path $exampleDir 'Sales.SemanticModel'

Test-Case 'validate: committed example is clean' {
    $r = Invoke-Script $validate @{ ReportPath = $cleanReport; ModelPath = $cleanModel }
    Assert-Equal 0 $r.ExitCode 'the committed example should validate with no errors'
    Assert-Match $r.Output 'No issues found' 'expected a clean report'
}

Test-Case 'validate: reads the model TMDL' {
    $r = Invoke-Script $validate @{ ReportPath = $cleanReport; ModelPath = $cleanModel }
    Assert-Match $r.Output 'Loaded 3 table\(s\)' 'should load Sales, Date and Product from TMDL'
}

Test-Case 'validate: catches an unbound data visual' {
    $path = New-BrokenReport 'unbound' {
        param($report, $visuals)
        Set-JsonFile -Path (Join-Path $visuals 'mix\visual.json') -Content @'
{
  "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.1.0/schema.json",
  "name": "0123456789abcdef0123",
  "position": { "x": 856, "y": 464, "z": 1000, "width": 400, "height": 232, "tabOrder": 1000 },
  "visual": { "visualType": "donutChart", "drillFilterOtherVisuals": true }
}
'@
    }
    $r = Invoke-Script $validate @{ ReportPath = $path; ModelPath = $cleanModel }
    Assert-Equal 1 $r.ExitCode 'an unbound visual is an error'
    Assert-Match $r.Output 'visual-unbound' 'expected the visual-unbound rule to fire'
}

Test-Case 'validate: catches a measure that does not exist' {
    $path = New-BrokenReport 'badmeasure' {
        param($report, $visuals)
        Edit-JsonFile -Path (Join-Path $visuals 'trend\visual.json') -Find 'Total Sales' -Replace 'Revenue Total'
    }
    $r = Invoke-Script $validate @{ ReportPath = $path; ModelPath = $cleanModel }
    Assert-Equal 1 $r.ExitCode 'a missing measure is an error'
    Assert-Match $r.Output 'ref-field-missing' 'expected the ref-field-missing rule to fire'
}

Test-Case 'validate: catches a table that does not exist' {
    $path = New-BrokenReport 'badtable' {
        param($report, $visuals)
        Edit-JsonFile -Path (Join-Path $visuals 'breakdown\visual.json') -Find '"Entity": "Product"' -Replace '"Entity": "Producto"'
    }
    $r = Invoke-Script $validate @{ ReportPath = $path; ModelPath = $cleanModel }
    Assert-Equal 1 $r.ExitCode 'a missing table is an error'
    Assert-Match $r.Output 'ref-table-missing' 'expected the ref-table-missing rule to fire'
}

Test-Case 'validate: flags a case mismatch as a warning, not an error' {
    $path = New-BrokenReport 'casemismatch' {
        param($report, $visuals)
        Edit-JsonFile -Path (Join-Path $visuals 'breakdown\visual.json') -Find '"Entity": "Product"' -Replace '"Entity": "product"'
    }
    $r = Invoke-Script $validate @{ ReportPath = $path; ModelPath = $cleanModel }
    Assert-Equal 0 $r.ExitCode 'a case mismatch should warn, not fail'
    Assert-Match $r.Output 'ref-table-case' 'expected the ref-table-case rule to fire'
}

Test-Case 'validate: catches a duplicate visual name' {
    $path = New-BrokenReport 'duplicate' {
        param($report, $visuals)
        $donor = [System.IO.File]::ReadAllText((Join-Path $visuals 'trend\visual.json'))
        $name = ([regex]::Match($donor, '"name":\s*"([^"]+)"')).Groups[1].Value
        $target = Join-Path $visuals 'breakdown\visual.json'
        $own = ([regex]::Match([System.IO.File]::ReadAllText($target), '"name":\s*"([^"]+)"')).Groups[1].Value
        Edit-JsonFile -Path $target -Find $own -Replace $name
    }
    $r = Invoke-Script $validate @{ ReportPath = $path; ModelPath = $cleanModel }
    Assert-Equal 1 $r.ExitCode 'a duplicate visual name is an error'
    Assert-Match $r.Output 'visual-duplicate-name' 'expected the visual-duplicate-name rule to fire'
}

Test-Case 'validate: catches a page missing from pages.json' {
    $path = New-BrokenReport 'unindexed' {
        param($report, $visuals)
        $pageFile = Join-Path $report 'definition\pages\overview\page.json'
        $token = ([regex]::Match([System.IO.File]::ReadAllText($pageFile), '"name":\s*"([^"]+)"')).Groups[1].Value
        Edit-JsonFile -Path $pageFile -Find $token -Replace 'ffffffffffffffffffff'
    }
    $r = Invoke-Script $validate @{ ReportPath = $path; ModelPath = $cleanModel }
    Assert-Equal 1 $r.ExitCode 'an unindexed page is an error'
    Assert-Match $r.Output 'page-not-indexed' 'expected the page-not-indexed rule to fire'
}

Test-Case 'validate: catches overlapping visuals as a warning' {
    $path = New-BrokenReport 'overlap' {
        param($report, $visuals)
        Edit-JsonFile -Path (Join-Path $visuals 'breakdown\visual.json') -Find '"x": 856' -Replace '"x": 700'
    }
    $r = Invoke-Script $validate @{ ReportPath = $path; ModelPath = $cleanModel }
    Assert-Equal 0 $r.ExitCode 'an overlap should warn, not fail'
    Assert-Match $r.Output 'visual-overlap' 'expected the visual-overlap rule to fire'
}

Test-Case 'validate: -FailOnWarning turns a warning into a failure' {
    $path = Join-Path $workspace 'overlap.Report'
    $r = Invoke-Script $validate @{ ReportPath = $path; ModelPath = $cleanModel; FailOnWarning = $true }
    Assert-Equal 1 $r.ExitCode '-FailOnWarning should fail on a warning-only report'
}

Test-Case 'validate: catches a broken byPath binding' {
    $path = New-BrokenReport 'badbinding' {
        param($report, $visuals)
        # The path inside definition.pbir is JSON-escaped, so on disk it reads '..\\Sales.SemanticModel'.
        Edit-JsonFile -Path (Join-Path $report 'definition.pbir') -Find 'Sales.SemanticModel' -Replace 'Nope.SemanticModel'
    }
    $r = Invoke-Script $validate @{ ReportPath = $path }
    Assert-Equal 1 $r.ExitCode 'a byPath target that does not exist is an error'
    Assert-Match $r.Output 'binding-broken' 'expected the binding-broken rule to fire'
}

Test-Case 'validate: reports invalid JSON rather than crashing' {
    $path = New-BrokenReport 'badjson' {
        param($report, $visuals)
        Set-JsonFile -Path (Join-Path $visuals 'mix\visual.json') -Content '{ "name": "oops", '
    }
    $r = Invoke-Script $validate @{ ReportPath = $path; ModelPath = $cleanModel }
    Assert-Equal 1 $r.ExitCode 'invalid JSON is an error'
    Assert-Match $r.Output 'json-invalid' 'expected the json-invalid rule to fire'
}

# ---------------------------------------------------------------------------------------------
# preview-pbir.ps1
# ---------------------------------------------------------------------------------------------

Write-Host ''
Write-Host 'preview-pbir' -ForegroundColor Cyan

Test-Case 'preview: renders the example with no issues' {
    $out = Join-Path $workspace 'preview-clean.html'
    $r = & $preview -ReportPath $cleanReport -OutputPath $out 6>$null
    Assert-NoBom $out
    Assert-Equal 1 $r.Pages 'expected one page'
    Assert-Equal 5 $r.Visuals 'expected five visuals'
    Assert-Equal 0 $r.Issues 'the committed example should render without issues'
}

Test-Case 'preview: SVG is well-formed XML' {
    $html = [System.IO.File]::ReadAllText((Join-Path $workspace 'preview-clean.html'))
    $svg = ([regex]::Match($html, '(?s)<svg.*?</svg>')).Value
    Assert-True ($svg.Length -gt 0) 'no SVG found in the output'
    [xml]$svg | Out-Null
}

Test-Case 'preview: labels visuals with their field bindings' {
    $html = [System.IO.File]::ReadAllText((Join-Path $workspace 'preview-clean.html'))
    Assert-Match $html 'Category: Product\[Category\]' 'expected the bar chart category binding in a label'
    Assert-Match $html 'Y: Sales\[Total Sales\]' 'expected the measure binding in a label'
    Assert-Match $html 'Sales Overview' 'expected the textbox content in a label'
}

Test-Case 'preview: flags unbound and overlapping visuals' {
    $out = Join-Path $workspace 'preview-broken.html'
    $r = & $preview -ReportPath (Join-Path $workspace 'unbound.Report') -OutputPath $out 6>$null
    Assert-True ($r.Issues -gt 0) 'expected at least one issue'
    $html = [System.IO.File]::ReadAllText($out)
    Assert-Match $html 'no field bindings' 'expected the unbound visual called out'
    Assert-Match $html 'stroke="#A4262C"' 'expected a red outline on the broken visual'
}

Test-Case 'preview: -PageName filters to one page' {
    $out = Join-Path $workspace 'preview-filtered.html'
    $r = & $preview -ReportPath $cleanReport -OutputPath $out -PageName 'overview' 6>$null
    Assert-Equal 1 $r.Pages 'expected the named page only'
}

Test-Case 'preview: rejects a folder that is not a report' {
    $threw = $false
    try { & $preview -ReportPath $workspace -OutputPath (Join-Path $workspace 'nope.html') 6>$null }
    catch { $threw = $true }
    Assert-True $threw 'previewing a non-report folder should throw'
}

# ---------------------------------------------------------------------------------------------
# harvest-visual-schema.ps1
# ---------------------------------------------------------------------------------------------

Write-Host ''
Write-Host 'harvest-visual-schema' -ForegroundColor Cyan

$harvestOut = Join-Path $workspace 'harvest'

Test-Case 'harvest: produces markdown and json' {
    $r = & $harvest -Path $cleanReport -OutputPath $harvestOut 6>$null
    Assert-FileExists (Join-Path $harvestOut 'visual-schema.md')
    Assert-FileExists (Join-Path $harvestOut 'visual-schema.json')
    Assert-NoBom (Join-Path $harvestOut 'visual-schema.md')
    Assert-NoBom (Join-Path $harvestOut 'visual-schema.json')
    Assert-Equal 5 $r.Scanned 'expected five visual.json files'
    Assert-Equal 0 $r.Skipped 'no file should have been skipped'
}

Test-Case 'harvest: records the roles it actually saw' {
    $data = Get-Content -LiteralPath (Join-Path $harvestOut 'visual-schema.json') -Raw | ConvertFrom-Json
    $bar = $data.visualTypes | Where-Object { $_.visualType -eq 'barChart' }
    Assert-True ($null -ne $bar) 'barChart missing from the harvest'
    $roles = @($bar.roles | ForEach-Object { $_.role })
    Assert-True ($roles -contains 'Category') 'barChart should report a Category role'
    Assert-True ($roles -contains 'Y') 'barChart should report a Y role'
    $y = $bar.roles | Where-Object { $_.role -eq 'Y' }
    Assert-True (@($y.fieldKinds) -contains 'Measure') 'the Y role should be recorded as carrying a Measure'
}

Test-Case 'harvest: attributes visuals to their report folder' {
    $data = Get-Content -LiteralPath (Join-Path $harvestOut 'visual-schema.json') -Raw | ConvertFrom-Json
    $bar = $data.visualTypes | Where-Object { $_.visualType -eq 'barChart' }
    Assert-True (@($bar.sources) -contains 'Sales Overview.Report') 'source should be the .Report folder name'
}

Test-Case 'harvest: notes types that carry no bindings' {
    $md = Get-Content -LiteralPath (Join-Path $harvestOut 'visual-schema.md') -Raw
    Assert-Match $md 'textbox' 'textbox should appear in the harvest'
    Assert-Match $md 'No query roles observed' 'a binding-free type should be described as such'
}

# ---------------------------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------------------------

Write-Host ''
Write-Host ("{0} passed, {1} failed{2}" -f $script:passed, $script:failed, $(if ($script:skipped -gt 0) { ", $($script:skipped) skipped" } else { '' })) -ForegroundColor $(if ($script:failed -gt 0) { 'Red' } else { 'Green' })

if ($script:failed -gt 0) {
    Write-Host ''
    Write-Host 'Failures:' -ForegroundColor Red
    foreach ($f in $script:failures) {
        Write-Host ("  - {0}" -f $f.Name) -ForegroundColor Red
        Write-Host ("    {0}" -f $f.Message)
    }
}

if ($KeepWorkspace) {
    Write-Host ''
    Write-Host "Workspace kept at $workspace"
}
else {
    Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if ($script:failed -gt 0) { exit 1 }
exit 0
