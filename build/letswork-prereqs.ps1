$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ollamaUrl = 'http://127.0.0.1:11434'
$ollamaDownloadUrl = 'https://ollama.com/download/OllamaSetup.exe'

function Find-OllamaExe {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'),
    (Join-Path $env:LOCALAPPDATA 'Ollama\ollama.exe'),
    (Join-Path $env:ProgramFiles 'Ollama\ollama.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  $cmd = Get-Command ollama.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Test-OllamaApi {
  try {
    $null = Invoke-RestMethod -Uri "$ollamaUrl/api/tags" -Method Get -TimeoutSec 3
    return $true
  } catch {
    return $false
  }
}

function Wait-OllamaApi([int]$Seconds = 30) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    if (Test-OllamaApi) { return $true }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Get-GpuVramBytes {
  try {
    $rows = & nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>$null
    $values = @($rows | ForEach-Object { [double]($_.Trim()) } | Where-Object { $_ -gt 0 })
    if ($values.Count -gt 0) {
      return (($values | Measure-Object -Maximum).Maximum * 1MB)
    }
  } catch {}

  try {
    $value = (Get-CimInstance Win32_VideoController | Measure-Object -Property AdapterRAM -Maximum).Maximum
    if ($value) { return [double]$value }
  } catch {}

  return 0
}

$ramBytes = 0
try { $ramBytes = [double](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory } catch {}
$gpuBytes = Get-GpuVramBytes
$model = if ($ramBytes -ge 16GB -and $gpuBytes -ge 6GB) { 'llama3.1:8b' } else { 'llama3.2:3b' }

Write-Host "Preparando a IA local do LetsWork com $model..."

$ollamaExe = Find-OllamaExe
if (-not $ollamaExe) {
  $tempInstaller = Join-Path $env:TEMP 'LetsWork-OllamaSetup.exe'
  Remove-Item $tempInstaller -Force -ErrorAction SilentlyContinue

  Write-Host 'Baixando o instalador oficial do Ollama...'
  Invoke-WebRequest -Uri $ollamaDownloadUrl -OutFile $tempInstaller -UseBasicParsing

  $signature = Get-AuthenticodeSignature -FilePath $tempInstaller
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Ollama') {
    Remove-Item $tempInstaller -Force -ErrorAction SilentlyContinue
    throw 'A assinatura digital do instalador do Ollama nao e valida.'
  }

  Write-Host 'Instalando Ollama...'
  $proc = Start-Process -FilePath $tempInstaller -ArgumentList '/VERYSILENT','/NORESTART','/SUPPRESSMSGBOXES' -PassThru
  $proc.WaitForExit()
  Remove-Item $tempInstaller -Force -ErrorAction SilentlyContinue
  if ($proc.ExitCode -ne 0) {
    throw "A instalacao do Ollama falhou com codigo $($proc.ExitCode)."
  }

  $ollamaExe = Find-OllamaExe
  if (-not $ollamaExe) {
    throw 'O Ollama terminou a instalacao, mas o executavel nao foi localizado.'
  }
}

if (-not (Test-OllamaApi)) {
  Write-Host 'Iniciando o servico local do Ollama...'
  Start-Process -FilePath $ollamaExe -ArgumentList 'serve' -WindowStyle Hidden
  if (-not (Wait-OllamaApi 45)) {
    throw 'O Ollama foi instalado, mas o servico local nao respondeu.'
  }
}

$installed = & $ollamaExe list 2>$null | Out-String
if ($installed -notmatch [regex]::Escape($model)) {
  Write-Host "Baixando o modelo $model. A instalacao so termina quando a IA estiver pronta..."
  & $ollamaExe pull $model
  if ($LASTEXITCODE -ne 0) {
    throw "Falha ao baixar o modelo $model."
  }
}

$installed = & $ollamaExe list 2>$null | Out-String
if ($installed -notmatch [regex]::Escape($model)) {
  throw "O modelo $model nao ficou disponivel apos a instalacao."
}

$dataRoot = Join-Path $env:USERPROFILE 'LetsWork\dados'
New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
@{
  provider = 'ollama'
  model = $model
  installedAt = (Get-Date).ToUniversalTime().ToString('o')
} | ConvertTo-Json | Set-Content -Path (Join-Path $dataRoot 'ai-install.json') -Encoding UTF8

Write-Host 'IA local pronta.'
exit 0
