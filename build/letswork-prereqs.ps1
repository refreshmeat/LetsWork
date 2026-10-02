$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ollamaUrl = 'http://127.0.0.1:11434'
$ollamaDownloadUrl = 'https://ollama.com/download/OllamaSetup.exe'
$logFile = Join-Path $env:TEMP 'LetsWork-AI-Install.log'
$errorFile = Join-Path $env:TEMP 'LetsWork-AI-Install-error.txt'
Remove-Item -LiteralPath $logFile -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $errorFile -Force -ErrorAction SilentlyContinue

function Write-InstallLog([string]$Message) {
  $line = ('[{0}] {1}' -f (Get-Date).ToString('s'), $Message)
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
  Write-Host $Message
}

function Invoke-WithRetry([scriptblock]$Action, [string]$Label, [int]$Attempts = 3, [int]$DelaySeconds = 4) {
  $lastError = $null
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    try {
      if ($attempt -gt 1) { Write-InstallLog "$Label - tentativa $attempt de $Attempts..." }
      & $Action
      return
    } catch {
      $lastError = $_
      Write-InstallLog "$Label falhou na tentativa ${attempt}: $($_.Exception.Message)"
      if ($attempt -lt $Attempts) { Start-Sleep -Seconds $DelaySeconds }
    }
  }
  throw $lastError
}

function Find-OllamaExe {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'),
    (Join-Path $env:LOCALAPPDATA 'Ollama\ollama.exe'),
    (Join-Path $env:ProgramFiles 'Ollama\ollama.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  $cmd = Get-Command ollama.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Test-OllamaApi {
  try {
    $null = Invoke-RestMethod -Uri "$ollamaUrl/api/tags" -Method Get -TimeoutSec 4
    return $true
  } catch {
    return $false
  }
}

function Wait-OllamaApi([int]$Seconds = 90) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    if (Test-OllamaApi) { return $true }
    Start-Sleep -Milliseconds 750
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Test-OllamaModel([string]$Model) {
  try {
    $data = Invoke-RestMethod -Uri "$ollamaUrl/api/tags" -Method Get -TimeoutSec 8
    foreach ($item in @($data.models)) {
      $name = [string]($item.name)
      if (-not $name) { $name = [string]($item.model) }
      if ($name -eq $Model -or $name.StartsWith($Model + '-')) { return $true }
    }
  } catch {}
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

try {
  $model = 'llama3.2:3b'

  Write-InstallLog "Preparando a IA local do LetsWork com $model..."

  $ollamaExe = Find-OllamaExe
  try {
    $driveRoot = [System.IO.Path]::GetPathRoot($env:USERPROFILE)
    $freeBytes = [System.IO.DriveInfo]::new($driveRoot).AvailableFreeSpace
    $requiredBytes = if ($ollamaExe) { 3GB } else { 7GB }
    if ($freeBytes -lt $requiredBytes) {
      $freeGB = [math]::Round($freeBytes / 1GB, 1)
      $requiredGB = [math]::Round($requiredBytes / 1GB, 0)
      throw ("Espaco livre insuficiente na unidade do usuario: {0} GB. Libere pelo menos {1} GB e tente novamente." -f $freeGB,$requiredGB)
    }
  } catch {
    if ($_.Exception.Message -like 'Espaco livre insuficiente*') { throw }
    Write-InstallLog "Nao foi possivel medir o espaco livre; continuando a validacao."
  }

  if (-not $ollamaExe) {
    $tempInstaller = Join-Path $env:TEMP 'LetsWork-OllamaSetup.exe'
    Remove-Item -LiteralPath $tempInstaller -Force -ErrorAction SilentlyContinue

    Invoke-WithRetry -Label 'Download do Ollama' -Action {
      Write-InstallLog 'Baixando o instalador oficial do Ollama...'
      Remove-Item -LiteralPath $tempInstaller -Force -ErrorAction SilentlyContinue
      Invoke-WebRequest -Uri $ollamaDownloadUrl -OutFile $tempInstaller -UseBasicParsing -TimeoutSec 1800
      if (-not (Test-Path -LiteralPath $tempInstaller)) { throw 'O arquivo do instalador nao foi criado.' }
      if ((Get-Item -LiteralPath $tempInstaller).Length -lt 1MB) { throw 'O download do Ollama ficou incompleto.' }
    }

    $signature = Get-AuthenticodeSignature -FilePath $tempInstaller
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Ollama') {
      Remove-Item -LiteralPath $tempInstaller -Force -ErrorAction SilentlyContinue
      throw 'A assinatura digital do instalador do Ollama nao e valida.'
    }

    Write-InstallLog 'Instalando Ollama silenciosamente...'

    # Mesmo marcador usado pelo instalador oficial do Ollama para impedir
    # que o app/TUI seja aberto durante uma instalacao silenciosa.
    $markerDir = Join-Path $env:LOCALAPPDATA 'Ollama'
    $markerFile = Join-Path $markerDir 'upgraded'
    New-Item -ItemType Directory -Force -Path $markerDir | Out-Null
    New-Item -ItemType File -Force -Path $markerFile | Out-Null

    $installerArgs = '/VERYSILENT /NORESTART /SUPPRESSMSGBOXES'
    $proc = Start-Process -FilePath $tempInstaller -ArgumentList $installerArgs -PassThru
    $proc.WaitForExit()
    $installerExitCode = $proc.ExitCode
    Remove-Item -LiteralPath $tempInstaller -Force -ErrorAction SilentlyContinue

    if ($installerExitCode -ne 0) {
      throw "A instalacao do Ollama falhou com codigo $installerExitCode."
    }

    $deadline = (Get-Date).AddSeconds(20)
    do {
      $ollamaExe = Find-OllamaExe
      if ($ollamaExe) { break }
      Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    if (-not $ollamaExe) {
      throw 'O Ollama terminou a instalacao, mas o executavel nao foi localizado.'
    }
    Write-InstallLog "Ollama instalado em $ollamaExe"
  } else {
    Write-InstallLog "Ollama ja instalado em $ollamaExe"
  }

  if (-not (Test-OllamaApi)) {
    Write-InstallLog 'Iniciando o servico local do Ollama...'
    Start-Process -FilePath $ollamaExe -ArgumentList 'serve' -WindowStyle Hidden | Out-Null
    if (-not (Wait-OllamaApi 90)) {
      throw 'O Ollama foi instalado, mas o servico local nao respondeu em 90 segundos.'
    }
  }
  Write-InstallLog 'Servico local do Ollama conectado.'

  if (-not (Test-OllamaModel $model)) {
    Invoke-WithRetry -Label "Download do modelo $model" -Attempts 3 -DelaySeconds 5 -Action {
      Write-InstallLog "Baixando o modelo $model. Isso pode levar varios minutos..."
      $pullOutput = & $ollamaExe pull $model 2>&1
      if ($pullOutput) { Add-Content -LiteralPath $logFile -Value ($pullOutput | Out-String) -Encoding UTF8 }
      if ($LASTEXITCODE -ne 0) {
        $detail = (($pullOutput | Select-Object -Last 6) -join ' ').Trim()
        if ($detail) {
          throw "Falha ao baixar o modelo $model (codigo $LASTEXITCODE): $detail"
        }
        throw "Falha ao baixar o modelo $model (codigo $LASTEXITCODE)."
      }
      if (-not (Test-OllamaModel $model)) {
        throw "O modelo $model ainda nao aparece na API do Ollama."
      }
    }
  }

  if (-not (Test-OllamaApi)) {
    throw 'O servico do Ollama deixou de responder durante a validacao final.'
  }
  if (-not (Test-OllamaModel $model)) {
    throw "O modelo $model nao ficou disponivel apos a instalacao."
  }

  $dataRoot = Join-Path $env:USERPROFILE 'LetsWork\dados'
  New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
  @{
    provider = 'ollama'
    model = $model
    installedAt = (Get-Date).ToUniversalTime().ToString('o')
    ready = $true
  } | ConvertTo-Json | Set-Content -Path (Join-Path $dataRoot 'ai-install.json') -Encoding UTF8

  Write-InstallLog "IA local pronta. Modelo confirmado: $model"
  exit 0
} catch {
  $errorMessage = [string]$_.Exception.Message
  Write-InstallLog ('ERRO: ' + $errorMessage)
  Write-InstallLog "Consulte o log: $logFile"
  Set-Content -LiteralPath $errorFile -Value $errorMessage -Encoding UTF8
  exit 1
}

