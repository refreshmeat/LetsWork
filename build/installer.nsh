!macro customInstall
  DetailPrint "Preparando a IA local do LetsWork. Esta etapa pode baixar varios GB e levar alguns minutos..."
  File /oname=$PLUGINSDIR\letswork-prereqs.ps1 "${BUILD_RESOURCES_DIR}\letswork-prereqs.ps1"

  ExecWait '"$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$PLUGINSDIR\letswork-prereqs.ps1"' $0
  ${if} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "Nao foi possivel preparar a IA local do LetsWork. O instalador tentou novamente automaticamente, mas a etapa ainda falhou.$\r$\n$\r$\nVerifique a internet e o arquivo de diagnostico:$\r$\n$TEMP\LetsWork-AI-Install.log"
    Abort
  ${endIf}
  DetailPrint "IA local do LetsWork pronta."
!macroend
