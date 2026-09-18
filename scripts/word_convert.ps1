param(
  [Parameter(Mandatory=$true)][string]$InputPath,
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [Parameter(Mandatory=$true)][ValidateSet('docx','pdf')][string]$Mode
)
$ErrorActionPreference = 'Stop'
$word = $null
$doc = $null
try {
  if (Test-Path $OutputPath) { Remove-Item -Force $OutputPath }
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $doc = $word.Documents.Open($InputPath, $false, $true)
  if ($Mode -eq 'docx') {
    $doc.SaveAs2($OutputPath, 16)
  } else {
    $doc.ExportAsFixedFormat($OutputPath, 17)
  }
  Write-Output $OutputPath
} finally {
  if ($doc -ne $null) { $doc.Close($false) }
  if ($word -ne $null) { $word.Quit() }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}