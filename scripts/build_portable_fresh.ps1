$root=Split-Path -Parent $PSScriptRoot
Set-Location $root
$subject='CN=LetsWork Local Code Signing'
$cert=Get-ChildItem Cert:\CurrentUser\My | Where-Object {$_.Subject -eq $subject} | Sort-Object NotAfter -Descending | Select-Object -First 1
if(-not $cert){throw 'Certificado LetsWork não encontrado'}
$chars=(48..57)+(65..90)+(97..122)
$plain=-join(1..32|ForEach-Object{[char]($chars|Get-Random)})
$secure=ConvertTo-SecureString $plain -AsPlainText -Force
$pfx=Join-Path $root '.letswork-final-sign.pfx'
$outName='dist-release-'+[DateTime]::Now.ToString('yyyyMMddHHmmss')
$out=Join-Path $root $outName
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $secure -Force|Out-Null
$env:CSC_LINK=$pfx;$env:CSC_KEY_PASSWORD=$plain
try{& npx electron-builder --win portable "--config.directories.output=$outName" --config.compression=normal;if($LASTEXITCODE-ne 0){throw 'build falhou'}}finally{Remove-Item Env:CSC_LINK,Env:CSC_KEY_PASSWORD -ErrorAction SilentlyContinue;Remove-Item $pfx -Force -ErrorAction SilentlyContinue}
$src=Join-Path $out 'LetsWork 0.1.0.exe'
$dst=Join-Path ([Environment]::GetFolderPath('Desktop')) 'LetsWork.exe'
Copy-Item $src $dst -Force
$s=Get-AuthenticodeSignature $dst
Write-Host "DESKTOP_EXE=$dst"
Write-Host "SIGNATURE=$($s.Status)"
Write-Host "SIZE=$((Get-Item $dst).Length)"