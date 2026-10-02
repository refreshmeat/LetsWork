!macro customInstall
  DetailPrint "Preparando a IA local do LetsWork. Esta etapa pode baixar alguns GB e levar varios minutos..."
  File /oname=$PLUGINSDIR\letswork-prereqs.ps1 "${BUILD_RESOURCES_DIR}\letswork-prereqs.ps1"

  ExecWait '"$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$PLUGINSDIR\letswork-prereqs.ps1"' $0
  ${if} $0 != 0
    StrCpy $1 "Falha desconhecida. Consulte $TEMP\LetsWork-AI-Install.log"
    IfFileExists "$TEMP\LetsWork-AI-Install-error.txt" 0 showInstallError
    ClearErrors
    FileOpen $2 "$TEMP\LetsWork-AI-Install-error.txt" r
    IfErrors showInstallError
    FileRead $2 $1
    FileClose $2

showInstallError:
    MessageBox MB_ICONSTOP|MB_OK "Nao foi possivel preparar a IA local do LetsWork.$\r$\n$\r$\nMotivo: $1$\r$\n$\r$\nLog completo:$\r$\n$TEMP\LetsWork-AI-Install.log"
    Abort
  ${endIf}
  DetailPrint "IA local do LetsWork pronta."
!macroend
