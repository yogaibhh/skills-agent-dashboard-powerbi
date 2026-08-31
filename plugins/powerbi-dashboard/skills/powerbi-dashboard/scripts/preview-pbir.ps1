<#
.SYNOPSIS
    Render a PBIR report as an HTML wireframe so you can see the layout without opening Power BI.

.DESCRIPTION
    Reads every page and visual in a PBIR report folder and emits a single self-contained HTML file:
    one to-scale SVG wireframe per page, each visual drawn as a labelled box showing its folder name,
    visual type, and field bindings.

    This closes the feedback loop during generation - an agent (or you) can check placement, spot
    overlaps and empty visuals, and fix them before ever launching Power BI Desktop.

    Boxes are colour-coded by visual family, and anything the renderer considers broken - overlapping,
    off-canvas, or a data visual with no field bindings - is outlined in red and listed under the page.

.PARAMETER ReportPath
    Path to the *.Report folder (the one containing definition.pbir and definition\).

.PARAMETER OutputPath
    Where to write the HTML. Defaults to "<report folder name>-preview.html" beside the report folder.

.PARAMETER PageName
    Optional. Render only the page whose folder name or displayName matches this value.

.PARAMETER Open
    Open the generated file in the default browser.

.EXAMPLE
    .\preview-pbir.ps1 -ReportPath "C:\pbi\Sales Overview.Report" -Open

.EXAMPLE
    .\preview-pbir.ps1 -ReportPath ".\Sales Overview.Report" -OutputPath ".\layout.html"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $ReportPath,

    [string] $OutputPath,

    [string] $PageName,

    [switch] $Open
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------

function ConvertTo-HtmlText {
    param([string] $Text)
    if ($null -eq $Text) { return '' }
    return $Text.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;')
}

function Get-Truncated {
    param([string] $Text, [int] $MaxChars)
    if ($MaxChars -lt 4) { return '' }
    if ($Text.Length -le $MaxChars) { return $Text }
    return $Text.Substring(0, $MaxChars - 1) + [char]0x2026
}

# Visual families drive the colour of each box.
$families = @{
    text  = @{ Label = 'Text / decoration'; Fill = '#F3F2F1'; Stroke = '#8A8886'; Ink = '#605E5C' }
    card  = @{ Label = 'Card / KPI';        Fill = '#EAF1FB'; Stroke = '#2E5EAA'; Ink = '#1F4380' }
    chart = @{ Label = 'Chart';             Fill = '#E9F5EE'; Stroke = '#3C9E64'; Ink = '#2A6E46' }
    table = @{ Label = 'Table / matrix';    Fill = '#F1ECF8'; Stroke = '#7A5EA8'; Ink = '#563F79' }
    slicer= @{ Label = 'Slicer / filter';   Fill = '#FDF3E3'; Stroke = '#C2851E'; Ink = '#8A5E14' }
    other = @{ Label = 'Other';             Fill = '#F5F5F5'; Stroke = '#A19F9D'; Ink = '#605E5C' }
}

$familyOf = @{}
foreach ($t in @('textbox', 'image', 'shape', 'basicShape', 'actionButton', 'blank')) { $familyOf[$t] = 'text' }
foreach ($t in @('cardVisual', 'card', 'multiRowCard', 'kpi', 'gauge')) { $familyOf[$t] = 'card' }
foreach ($t in @('barChart', 'columnChart', 'clusteredBarChart', 'clusteredColumnChart',
                 'stackedBarChart', 'stackedColumnChart', 'hundredPercentStackedBarChart',
                 'hundredPercentStackedColumnChart', 'lineChart', 'areaChart', 'stackedAreaChart',
                 'lineStackedColumnComboChart', 'lineClusteredColumnComboChart', 'pieChart',
                 'donutChart', 'treemap', 'funnel', 'waterfallChart', 'scatterChart', 'ribbonChart',
                 'map', 'filledMap', 'shapeMap', 'esriVisual')) { $familyOf[$t] = 'chart' }
foreach ($t in @('tableEx', 'pivotTable', 'matrix')) { $familyOf[$t] = 'table' }
foreach ($t in @('slicer', 'advancedSlicerVisual')) { $familyOf[$t] = 'slicer' }

# Types that legitimately carry no field bindings.
$noQueryTypes = @('textbox', 'image', 'shape', 'basicShape', 'actionButton', 'blank')

# ---------------------------------------------------------------------------------------------
# Read the report
# ---------------------------------------------------------------------------------------------

if (-not (Test-Path -LiteralPath $ReportPath)) {
    throw "Report path not found: $ReportPath"
}
$ReportPath = (Resolve-Path -LiteralPath $ReportPath).Path
$reportLabel = Split-Path $ReportPath -Leaf

$pagesDir = Join-Path $ReportPath 'definition\pages'
if (-not (Test-Path -LiteralPath $pagesDir)) {
    throw "No definition\pages folder under '$ReportPath'. Is this a PBIR report folder?"
}

$pageOrder = @()
$pagesJson = Join-Path $pagesDir 'pages.json'
if (Test-Path -LiteralPath $pagesJson) {
    try { $pageOrder = @((Get-Content -LiteralPath $pagesJson -Raw -Encoding UTF8 | ConvertFrom-Json).pageOrder) }
    catch { $pageOrder = @() }
}

$pages = @()

foreach ($pageDir in (Get-ChildItem -LiteralPath $pagesDir -Directory)) {
    $pageJsonPath = Join-Path $pageDir.FullName 'page.json'
    if (-not (Test-Path -LiteralPath $pageJsonPath)) { continue }

    try { $page = Get-Content -LiteralPath $pageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch {
        Write-Warning "Skipping '$($pageDir.Name)': page.json is not valid JSON."
        continue
    }

    $display = $page.displayName
    if ([string]::IsNullOrWhiteSpace($display)) { $display = $pageDir.Name }

    if ($PageName -and $pageDir.Name -ne $PageName -and $display -ne $PageName) { continue }

    $width  = 1280; if ($page.width)  { $width  = [double]$page.width }
    $height = 720;  if ($page.height) { $height = [double]$page.height }

    $visuals = @()
    $visualsDir = Join-Path $pageDir.FullName 'visuals'

    if (Test-Path -LiteralPath $visualsDir) {
        foreach ($vDir in (Get-ChildItem -LiteralPath $visualsDir -Directory | Sort-Object Name)) {
            $vPath = Join-Path $vDir.FullName 'visual.json'
            if (-not (Test-Path -LiteralPath $vPath)) { continue }

            try { $v = Get-Content -LiteralPath $vPath -Raw -Encoding UTF8 | ConvertFrom-Json }
            catch {
                Write-Warning "Skipping visual '$($vDir.Name)': visual.json is not valid JSON."
                continue
            }

            $type = 'unknown'
            if ($v.visual -and $v.visual.visualType) { $type = $v.visual.visualType }

            $pos = $v.position
            $x = 0.0; $y = 0.0; $w = 0.0; $h = 0.0
            if ($pos) {
                if ($null -ne $pos.x)      { $x = [double]$pos.x }
                if ($null -ne $pos.y)      { $y = [double]$pos.y }
                if ($null -ne $pos.width)  { $w = [double]$pos.width }
                if ($null -ne $pos.height) { $h = [double]$pos.height }
            }

            # --- field bindings, grouped by role ---
            $bindings = @()
            $queryState = $null
            if ($v.visual -and $v.visual.query) { $queryState = $v.visual.query.queryState }

            if ($null -ne $queryState) {
                foreach ($role in $queryState.PSObject.Properties) {
                    $fields = @()
                    foreach ($proj in @($role.Value.projections)) {
                        if ($null -eq $proj -or $null -eq $proj.field) { continue }
                        foreach ($kind in @('Measure', 'Column')) {
                            $node = $proj.field.$kind
                            if ($null -eq $node) { continue }
                            $entity = $null
                            if ($node.Expression -and $node.Expression.SourceRef) { $entity = $node.Expression.SourceRef.Entity }
                            if ($entity -and $node.Property) { $fields += "$entity[$($node.Property)]" }
                        }
                    }
                    if ($fields.Count -gt 0) {
                        $bindings += [PSCustomObject]@{ Role = $role.Name; Fields = $fields }
                    }
                }
            }

            # --- textbox content, so titles read as titles in the wireframe ---
            $textContent = $null
            if ($type -eq 'textbox' -and $v.visual.objects -and $v.visual.objects.general) {
                $runs = @()
                foreach ($g in @($v.visual.objects.general)) {
                    foreach ($para in @($g.properties.paragraphs)) {
                        foreach ($run in @($para.textRuns)) {
                            if ($run.value) { $runs += [string]$run.value }
                        }
                    }
                }
                if ($runs.Count -gt 0) { $textContent = ($runs -join ' ') }
            }

            $family = 'other'
            if ($familyOf.ContainsKey($type)) { $family = $familyOf[$type] }

            $visuals += [PSCustomObject]@{
                Folder   = $vDir.Name
                Type     = $type
                Family   = $family
                X = $x; Y = $y; W = $w; H = $h
                Bindings = $bindings
                Text     = $textContent
                Issues   = New-Object System.Collections.ArrayList
            }
        }
    }

    # --- issues ---
    foreach ($v in $visuals) {
        if ($v.W -le 0 -or $v.H -le 0) {
            [void]$v.Issues.Add('zero or negative size')
        }
        if (($v.X + $v.W) -gt ($width + 0.5) -or ($v.Y + $v.H) -gt ($height + 0.5) -or $v.X -lt -0.5 -or $v.Y -lt -0.5) {
            [void]$v.Issues.Add('extends past the canvas')
        }
        if ($v.Bindings.Count -eq 0 -and ($noQueryTypes -notcontains $v.Type)) {
            [void]$v.Issues.Add('no field bindings - renders empty')
        }
    }

    for ($i = 0; $i -lt $visuals.Count; $i++) {
        for ($j = $i + 1; $j -lt $visuals.Count; $j++) {
            $a = $visuals[$i]; $b = $visuals[$j]
            $ox = [math]::Min($a.X + $a.W, $b.X + $b.W) - [math]::Max($a.X, $b.X)
            $oy = [math]::Min($a.Y + $a.H, $b.Y + $b.H) - [math]::Max($a.Y, $b.Y)
            if ($ox -gt 1 -and $oy -gt 1) {
                [void]$a.Issues.Add("overlaps '$($b.Folder)'")
                [void]$b.Issues.Add("overlaps '$($a.Folder)'")
            }
        }
    }

    $orderIndex = [array]::IndexOf($pageOrder, $page.name)
    if ($orderIndex -lt 0) { $orderIndex = 9999 }

    $pages += [PSCustomObject]@{
        Folder     = $pageDir.Name
        Display    = $display
        Name       = $page.name
        Width      = $width
        Height     = $height
        Visuals    = $visuals
        OrderIndex = $orderIndex
        Indexed    = ($pageOrder -contains $page.name)
    }
}

if ($pages.Count -eq 0) {
    throw "No pages found to render under '$pagesDir'."
}

$pages = @($pages | Sort-Object OrderIndex, Folder)

# ---------------------------------------------------------------------------------------------
# Render
# ---------------------------------------------------------------------------------------------

$sb = New-Object System.Text.StringBuilder
function Add-Line { param([string] $Text) [void]$sb.AppendLine($Text) }

$totalVisuals = ($pages | ForEach-Object { $_.Visuals.Count } | Measure-Object -Sum).Sum
$totalIssues  = ($pages | ForEach-Object { ($_.Visuals | ForEach-Object { $_.Issues.Count } | Measure-Object -Sum).Sum } | Measure-Object -Sum).Sum
if ($null -eq $totalVisuals) { $totalVisuals = 0 }
if ($null -eq $totalIssues)  { $totalIssues = 0 }

$generated = (Get-Date).ToString('yyyy-MM-dd HH:mm')

Add-Line '<!doctype html>'
Add-Line '<html lang="en">'
Add-Line '<head>'
Add-Line '<meta charset="utf-8">'
Add-Line '<meta name="viewport" content="width=device-width, initial-scale=1">'
Add-Line ("<title>{0} - layout preview</title>" -f (ConvertTo-HtmlText $reportLabel))
Add-Line '<style>'
Add-Line @'
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #FAF9F8; color: #252423;
       font: 14px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif; }
.wrap { max-width: 1360px; margin: 0 auto; padding: 32px 24px 64px; }
header { border-bottom: 1px solid #E1DFDD; padding-bottom: 20px; margin-bottom: 32px; }
h1 { margin: 0 0 6px; font-size: 22px; font-weight: 600; }
.sub { color: #605E5C; font-size: 13px; }
.pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px;
        font-weight: 600; margin-left: 8px; }
.pill.ok { background: #E9F5EE; color: #2A6E46; }
.pill.bad { background: #FDECEA; color: #A4262C; }
section { margin-bottom: 44px; }
h2 { font-size: 17px; font-weight: 600; margin: 0 0 4px; }
.pagemeta { color: #605E5C; font-size: 12px; margin-bottom: 14px; }
.canvas { background: #fff; border: 1px solid #E1DFDD; border-radius: 10px; padding: 12px;
          box-shadow: 0 1px 3px rgba(0,0,0,.04); overflow-x: auto; }
svg { display: block; width: 100%; height: auto; min-width: 640px; }
ul.issues { list-style: none; padding: 0; margin: 14px 0 0; }
ul.issues li { background: #FDECEA; border-left: 3px solid #A4262C; padding: 7px 12px;
               margin-bottom: 6px; border-radius: 0 4px 4px 0; font-size: 13px; }
ul.issues code { background: rgba(0,0,0,.05); padding: 1px 5px; border-radius: 3px;
                 font-family: Consolas, "Cascadia Mono", monospace; font-size: 12px; }
.legend { display: flex; flex-wrap: wrap; gap: 18px; margin-top: 40px; padding-top: 20px;
          border-top: 1px solid #E1DFDD; font-size: 12px; color: #605E5C; }
.legend span { display: flex; align-items: center; gap: 7px; }
.swatch { width: 14px; height: 14px; border-radius: 3px; border: 1.5px solid; }
footer { margin-top: 32px; color: #8A8886; font-size: 12px; }
'@
Add-Line '</style>'
Add-Line '</head>'
Add-Line '<body><div class="wrap">'

Add-Line '<header>'
Add-Line ("<h1>{0}</h1>" -f (ConvertTo-HtmlText $reportLabel))
$badge = if ($totalIssues -eq 0) { '<span class="pill ok">no issues</span>' } else { ('<span class="pill bad">{0} issue{1}</span>' -f $totalIssues, $(if ($totalIssues -eq 1) { '' } else { 's' })) }
Add-Line ("<div class=""sub"">{0} page(s) &middot; {1} visual(s) &middot; generated {2}{3}</div>" -f $pages.Count, $totalVisuals, $generated, $badge)
Add-Line '</header>'

foreach ($page in $pages) {
    $pageIssues = ($page.Visuals | ForEach-Object { $_.Issues.Count } | Measure-Object -Sum).Sum
    if ($null -eq $pageIssues) { $pageIssues = 0 }

    Add-Line '<section>'
    Add-Line ("<h2>{0}</h2>" -f (ConvertTo-HtmlText $page.Display))

    $indexNote = ''
    if (-not $page.Indexed) { $indexNote = ' &middot; <strong>not listed in pages.json</strong>' }
    Add-Line ("<div class=""pagemeta"">folder <code>{0}</code> &middot; {1}&times;{2} &middot; {3} visual(s){4}</div>" -f
        (ConvertTo-HtmlText $page.Folder), [int]$page.Width, [int]$page.Height, $page.Visuals.Count, $indexNote)

    Add-Line '<div class="canvas">'
    Add-Line ("<svg viewBox=""0 0 {0} {1}"" xmlns=""http://www.w3.org/2000/svg"" role=""img"" aria-label=""Wireframe of page {2}"">" -f
        [int]$page.Width, [int]$page.Height, (ConvertTo-HtmlText $page.Display))
    Add-Line ("<rect x=""0"" y=""0"" width=""{0}"" height=""{1}"" fill=""#FFFFFF"" stroke=""#D2D0CE"" stroke-width=""1""/>" -f
        [int]$page.Width, [int]$page.Height)

    foreach ($v in ($page.Visuals | Sort-Object { $_.Y }, { $_.X })) {
        if ($v.W -le 0 -or $v.H -le 0) { continue }

        $fam = $families[$v.Family]
        $broken = $v.Issues.Count -gt 0
        $stroke = if ($broken) { '#A4262C' } else { $fam.Stroke }
        $dash   = if ($broken) { ' stroke-dasharray="6 3"' } else { '' }

        Add-Line ("<rect x=""{0}"" y=""{1}"" width=""{2}"" height=""{3}"" rx=""6"" fill=""{4}"" stroke=""{5}"" stroke-width=""1.5""{6}/>" -f
            [math]::Round($v.X, 1), [math]::Round($v.Y, 1), [math]::Round($v.W, 1), [math]::Round($v.H, 1),
            $fam.Fill, $stroke, $dash)

        # Text lines. Prio decides what survives in a short box: the folder name and any issue
        # always win, then the payload (bindings / text), and the visual type is dropped first -
        # the folder name usually implies it anyway.
        $lines = @()
        $lines += @{ Text = $v.Folder; Weight = '600'; Size = 12;   Color = $fam.Ink;  Prio = 1 }
        $lines += @{ Text = $v.Type;   Weight = '400'; Size = 10.5; Color = '#605E5C'; Prio = 4 }

        if ($v.Text) {
            $lines += @{ Text = '"' + $v.Text + '"'; Weight = '400'; Size = 10.5; Color = '#252423'; Prio = 3 }
        }
        foreach ($b in $v.Bindings) {
            $lines += @{ Text = ("{0}: {1}" -f $b.Role, ($b.Fields -join ', ')); Weight = '400'; Size = 10.5; Color = '#252423'; Prio = 3 }
        }
        if ($broken) {
            $lines += @{ Text = ($v.Issues | Select-Object -Unique) -join '; '; Weight = '600'; Size = 10.5; Color = '#A4262C'; Prio = 2 }
        }

        # Reserve a strip for the dimension badge so it never lands on a text line.
        $showBadge  = ($v.H -ge 40 -and $v.W -ge 130)
        $reserved   = if ($showBadge) { 16 } else { 4 }
        $lineHeight = 14
        $maxLines   = [math]::Floor(($v.H - 12 - $reserved) / $lineHeight)
        if ($maxLines -lt 1) { $maxLines = 1 }
        $charBudget = [math]::Floor(($v.W - 16) / 5.6)

        # Index them, keep the highest-priority ones that fit, then restore reading order.
        for ($i = 0; $i -lt $lines.Count; $i++) { $lines[$i].Index = $i }
        $visible = @($lines | Sort-Object @{ Expression = { $_.Prio } }, @{ Expression = { $_.Index } } |
                     Select-Object -First $maxLines |
                     Sort-Object @{ Expression = { $_.Index } })

        for ($i = 0; $i -lt $visible.Count; $i++) {
            $line = $visible[$i]
            $text = Get-Truncated $line.Text $charBudget
            if ([string]::IsNullOrWhiteSpace($text)) { continue }
            Add-Line ("<text x=""{0}"" y=""{1}"" font-family=""Segoe UI, system-ui, sans-serif"" font-size=""{2}"" font-weight=""{3}"" fill=""{4}"">{5}</text>" -f
                [math]::Round($v.X + 8, 1), [math]::Round($v.Y + 18 + ($i * $lineHeight), 1),
                $line.Size, $line.Weight, $line.Color, (ConvertTo-HtmlText $text))
        }

        if ($showBadge) {
            Add-Line ("<text x=""{0}"" y=""{1}"" text-anchor=""end"" font-family=""Consolas, monospace"" font-size=""9.5"" fill=""#A19F9D"">{2},{3} &#183; {4}&#215;{5}</text>" -f
                [math]::Round($v.X + $v.W - 8, 1), [math]::Round($v.Y + $v.H - 8, 1),
                [int]$v.X, [int]$v.Y, [int]$v.W, [int]$v.H)
        }
    }

    Add-Line '</svg>'
    Add-Line '</div>'

    if ($pageIssues -gt 0) {
        Add-Line '<ul class="issues">'
        foreach ($v in $page.Visuals) {
            foreach ($issue in ($v.Issues | Select-Object -Unique)) {
                Add-Line ("<li><code>{0}</code> ({1}) &mdash; {2}</li>" -f
                    (ConvertTo-HtmlText $v.Folder), (ConvertTo-HtmlText $v.Type), (ConvertTo-HtmlText $issue))
            }
        }
        Add-Line '</ul>'
    }

    Add-Line '</section>'
}

Add-Line '<div class="legend">'
foreach ($key in @('text', 'card', 'chart', 'table', 'slicer', 'other')) {
    $f = $families[$key]
    Add-Line ("<span><i class=""swatch"" style=""background:{0};border-color:{1}""></i>{2}</span>" -f $f.Fill, $f.Stroke, $f.Label)
}
Add-Line '<span><i class="swatch" style="background:#fff;border-color:#A4262C;border-style:dashed"></i>Has an issue</span>'
Add-Line '</div>'

Add-Line '<footer>Wireframe only - box positions are exact, but this is not a render of the actual visuals. Open the .pbip in Power BI Desktop to see real output.</footer>'
Add-Line '</div></body></html>'

# ---------------------------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $parent = Split-Path $ReportPath -Parent
    $OutputPath = Join-Path $parent ("{0}-preview.html" -f ($reportLabel -replace '\.Report$', ''))
}

$outDir = Split-Path $OutputPath -Parent
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

Set-Content -LiteralPath $OutputPath -Value $sb.ToString() -Encoding utf8
$OutputPath = (Resolve-Path -LiteralPath $OutputPath).Path

Write-Host ''
Write-Host "Wireframe written" -ForegroundColor Green
Write-Host "  $OutputPath"
Write-Host ("  {0} page(s), {1} visual(s), {2} issue(s)" -f $pages.Count, $totalVisuals, $totalIssues) -ForegroundColor $(if ($totalIssues -gt 0) { 'Yellow' } else { 'Gray' })
Write-Host ''

if ($Open) { Start-Process $OutputPath }

[PSCustomObject]@{
    OutputPath = $OutputPath
    Pages      = $pages.Count
    Visuals    = $totalVisuals
    Issues     = $totalIssues
}
