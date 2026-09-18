$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$subject = 'CN=LetsWork Local Code Signing'
$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object {
  $_.Subject -eq $subject -and $_.NotAfter -gt (Get-Date).AddMonths(3)
} | Sort-Object NotAfter -Descending | Select-Object -First 1
if (-not $cert) {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert `
    -Subject $subject -CertStoreLocation 'Cert:\CurrentUser\My' `
    -KeyExportPolicy Exportable -KeyLength 2048 -HashAlgorithm SHA256 `
    -NotAfter (Get-Date).AddYears(3)
}
$tempCer = Join-Path $env:TEMP 'letswork-local-signing.cer'
Export-Certificate -Cert $cert -FilePath $tempCer -Force | Out-Null
Import-Certificate -FilePath $tempCer -CertStoreLocation 'Cert:\CurrentUser\TrustedPublisher' | Out-Null
Import-Certificate -FilePath $tempCer -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null
Remove-Item $tempCer -Force -ErrorAction SilentlyContinue
$chars = (48..57)+(65..90)+(97..122)
$plain = -join (1..32 | ForEach-Object { [char]($chars | Get-Random) })
$secure = ConvertTo-SecureString $plain -AsPlainText -Force
$tempPfx = Join-Path $env:TEMP 'letswork-local-signing.pfx'
Export-PfxCertificate -Cert $cert -FilePath $tempPfx -Password $secure -Force | Out-Null
$env:CSC_LINK = $tempPfx
$env:CSC_KEY_PASSWORD = $plain
try {
  if (Test-Path (Join-Path $root 'dist')) { Remove-Item (Join-Path $root 'dist') -Recurse -Force }
  & npm run dist
  if ($LASTEXITCODE -ne 0) { throw "electron-builder falhou: $LASTEXITCODE" }
} finally {
  Remove-Item Env:CSC_LINK -ErrorAction SilentlyContinue
  Remove-Item Env:CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item $tempPfx -Force -ErrorAction SilentlyContinue
}
$setup = Join-Path $root 'dist\LetsWork Setup 0.1.0.exe'
$portable = Join-Path $root 'dist\LetsWork 0.1.0.exe'
$s1 = Get-AuthenticodeSignature $setup
$s2 = Get-AuthenticodeSignature $portable
if ($s1.Status -ne 'Valid' -or $s2.Status -ne 'Valid') {
  throw "Assinatura inválida. Setup=$($s1.Status), Portable=$($s2.Status)"
}
$desktop = [Environment]::GetFolderPath('Desktop')
$setupDest = Join-Path $desktop 'LetsWork Setup.exe'
$portableDest = Join-Path $desktop 'LetsWork.exe'
Copy-Item $setup $setupDest -Force
Copy-Item $portable $portableDest -Force
Write-Host "SIGNED_SETUP=$setupDest"
Write-Host "SIGNED_PORTABLE=$portableDest"
Write-Host "CERT=$($cert.Subject) / $($cert.Thumbprint)"
