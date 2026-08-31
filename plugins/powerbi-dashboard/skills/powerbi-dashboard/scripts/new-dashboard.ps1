<#
.SYNOPSIS
    Scaffold an empty PBIR report folder ready for generated visuals.

.DESCRIPTION
    Copies the bundled PBIP template into <OutputPath>\<Name>.Report, gives it a fresh logicalId and
    page name, wires definition.pbir to a semantic model, and writes a matching <Name>.pbip next to it.

    The scaffold contains one empty page and no visuals - the agent writes those afterwards using
    references/visual-catalog.md.

.PARAMETER Name
    Report name. Used for the folder (<Name>.Report), the .pbip file, and the item displayName.

.PARAMETER OutputPath
    Directory that will contain <Name>.Report and <Name>.pbip. Created if missing.

.PARAMETER ModelPath
    Relative path from the .Report folder to a local semantic model folder, e.g. "..\Sales.SemanticModel".
    Produces a byPath reference for local Power BI Desktop development.

.PARAMETER ByConnection
    Semantic model GUID in a Fabric workspace. Produces a byConnection reference, required for
    deploying to a workspace. Mutually exclusive with -ModelPath.

.PARAMETER PageName
    Display name of the first page. Defaults to "Overview".

.PARAMETER Force
    Overwrite <Name>.Report if it already exists.

.EXAMPLE
    .\new-dashboard.ps1 -Name "Sales Overview" -OutputPath "C:\pbi\SalesProject" -ModelPath "..\Sales.SemanticModel"

.EXAMPLE
    .\new-dashboard.ps1 -Name "Sales Overview" -OutputPath "C:\pbi\SalesProject" -ByConnection "3f2b9c10-1a4d-4c8e-9f01-2b3c4d5e6f70"
#>
[CmdletBinding(DefaultParameterSetName = 'ByPath')]
param(
    [Parameter(Mandatory = $true)]
    [string] $Name,

    [Parameter(Mandatory = $true)]
    [string] $OutputPath,

    [Parameter(Mandatory = $true, ParameterSetName = 'ByPath')]
    [string] $ModelPath,

    [Parameter(Mandatory = $true, ParameterSetName = 'ByConnection')]
    [string] $ByConnection,

    [string] $PageName = 'Overview',

    [switch] $Force
)

$ErrorActionPreference = 'Stop'

function New-PbirName {
    # 20 lowercase hex characters - the token format PBIR uses for internal object names.
    $chars = '0123456789abcdef'.ToCharArray()
    -join (1..20 | ForEach-Object { $chars[(Get-Random -Minimum 0 -Maximum 16)] })
}

# --- resolve paths -----------------------------------------------------------------------------

$templateRoot = Join-Path $PSScriptRoot '..\assets\template\Dashboard.Report'
if (-not (Test-Path $templateRoot)) {
    throw "Template not found at '$templateRoot'. Run this script from the skill's scripts folder."
}

if (-not (Test-Path $OutputPath)) {
    New-Item -ItemType Directory -Path $OutputPath -Force | Out-Null
}
$OutputPath = (Resolve-Path $OutputPath).Path

$invalid = [System.IO.Path]::GetInvalidFileNameChars()
if ($Name.IndexOfAny($invalid) -ge 0) {
    throw "Report name '$Name' contains characters that are not valid in a file name."
}

$reportFolder = Join-Path $OutputPath "$Name.Report"
$pbipFile     = Join-Path $OutputPath "$Name.pbip"

if (Test-Path $reportFolder) {
    if (-not $Force) {
        throw "'$reportFolder' already exists. Pass -Force to overwrite it."
    }
    Remove-Item $reportFolder -Recurse -Force
}

# --- copy template -----------------------------------------------------------------------------

Copy-Item -Path $templateRoot -Destination $reportFolder -Recurse -Force
Get-ChildItem -Path $reportFolder -Recurse -Filter '.gitkeep' | Remove-Item -Force

$logicalId = [guid]::NewGuid().ToString()
$pageToken = New-PbirName

# --- .platform ---------------------------------------------------------------------------------

$platform = @'
{
  "$schema": "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json",
  "metadata": {
    "type": "Report",
    "displayName": "__NAME__"
  },
  "config": {
    "version": "2.0",
    "logicalId": "__LOGICALID__"
  }
}
'@
$platform = $platform.Replace('__NAME__', $Name).Replace('__LOGICALID__', $logicalId)
Set-Content -Path (Join-Path $reportFolder '.platform') -Value $platform -Encoding utf8

# --- definition.pbir ---------------------------------------------------------------------------

if ($PSCmdlet.ParameterSetName -eq 'ByConnection') {
    $pbir = @'
{
  "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json",
  "version": "4.0",
  "datasetReference": {
    "byConnection": {
      "connectionString": "semanticmodelid=__MODELID__"
    }
  }
}
'@
    $pbir = $pbir.Replace('__MODELID__', $ByConnection)
    $binding = "byConnection -> $ByConnection"
}
else {
    $pbir = @'
{
  "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json",
  "version": "4.0",
  "datasetReference": {
    "byPath": {
      "path": "__MODELPATH__"
    }
  }
}
'@
    # JSON needs backslashes escaped.
    $pbir = $pbir.Replace('__MODELPATH__', $ModelPath.Replace('\', '\\'))
    $binding = "byPath -> $ModelPath"
}
Set-Content -Path (Join-Path $reportFolder 'definition.pbir') -Value $pbir -Encoding utf8

# --- pages -------------------------------------------------------------------------------------

$pagesJson = @'
{
  "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/pagesMetadata/1.0.0/schema.json",
  "pageOrder": [
    "__PAGE__"
  ],
  "activePageName": "__PAGE__"
}
'@
$pagesJson = $pagesJson.Replace('__PAGE__', $pageToken)
Set-Content -Path (Join-Path $reportFolder 'definition\pages\pages.json') -Value $pagesJson -Encoding utf8

$pageJson = @'
{
  "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/1.4.0/schema.json",
  "name": "__PAGE__",
  "displayName": "__DISPLAY__",
  "displayOption": "FitToPage",
  "height": 720,
  "width": 1280
}
'@
$pageJson = $pageJson.Replace('__PAGE__', $pageToken).Replace('__DISPLAY__', $PageName)
Set-Content -Path (Join-Path $reportFolder 'definition\pages\overview\page.json') -Value $pageJson -Encoding utf8

# --- .pbip -------------------------------------------------------------------------------------

$pbip = @'
{
  "$schema": "https://developer.microsoft.com/json-schemas/fabric/pbip/pbipProperties/1.0.0/schema.json",
  "version": "1.0",
  "artifacts": [
    {
      "report": {
        "path": "__FOLDER__"
      }
    }
  ],
  "settings": {
    "enableAutoRecovery": true
  }
}
'@
$pbip = $pbip.Replace('__FOLDER__', "$Name.Report")
Set-Content -Path $pbipFile -Value $pbip -Encoding utf8

# --- report ------------------------------------------------------------------------------------

Write-Host ''
Write-Host "Scaffolded '$Name'" -ForegroundColor Green
Write-Host "  Report folder : $reportFolder"
Write-Host "  Project file  : $pbipFile"
Write-Host "  Model binding : $binding"
Write-Host "  Page          : '$PageName' (folder 'overview', name '$pageToken')"
Write-Host ''
Write-Host 'Next: write visual.json files into' -NoNewline
Write-Host "  definition\pages\overview\visuals\<visualFolder>\visual.json" -ForegroundColor Cyan
Write-Host 'Then validate with validate-pbir.ps1.'
Write-Host ''

[PSCustomObject]@{
    Name         = $Name
    ReportPath   = $reportFolder
    PbipPath     = $pbipFile
    PageName     = $pageToken
    PageFolder   = Join-Path $reportFolder 'definition\pages\overview'
    VisualsPath  = Join-Path $reportFolder 'definition\pages\overview\visuals'
    LogicalId    = $logicalId
}
