$root=Split-Path -Parent $PSScriptRoot
Set-Location $root
$subject='CN=LetsWork Local Code Signing'
$cert=Get-ChildItem Cert:\CurrentUser\My | Where-Object {$_.Subject -eq $subject -and $_.HasPrivateKey} | Sort-Object NotAfter -Descending | Select-Object -First 1
if(-not $cert){throw 'Certificado LetsWork não encontrado'}
$out=Join-Path $env:TEMP ('LetsWorkBuild-'+[DateTime]::Now.ToString('yyyyMMddHHmmss'))
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'
try{
  & npx electron-builder --win portable "--config.directories.output=$out" --config.compression=normal
  if($LASTEXITCODE-ne 0){throw 'build falhou'}
  $src=Join-Path $out 'LetsWork 0.1.0.exe'
  if(-not (Test-Path $src)){throw 'Executável do build não encontrado'}
  $dst=Join-Path ([Environment]::GetFolderPath('Desktop')) 'LetsWork.exe'
  Copy-Item $src $dst -Force
  $sig=Set-AuthenticodeSignature -FilePath $dst -Certificate $cert -HashAlgorithm SHA256
  Write-Host "DESKTOP_EXE=$dst"
  Write-Host "SIGNATURE=$($sig.Status)"
  Write-Host "SIZE=$((Get-Item $dst).Length)"
} finally {
  Remove-Item Env:CSC_IDENTITY_AUTO_DISCOVERY -ErrorAction SilentlyContinue
  if(Test-Path $out){[System.IO.Directory]::Delete($out,$true)}
}