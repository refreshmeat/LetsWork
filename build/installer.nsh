!macro customInstall
  ${ifNot} ${isUpdated}
    DetailPrint "Preparando a IA local do LetsWork..."
    File /oname=$PLUGINSDIR\letswork-prereqs.ps1 "${BUILD_RESOURCES_DIR}\letswork-prereqs.ps1"

    ExecWait '"$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\letswork-prereqs.ps1"' $0
    ${if} $0 != 0
      MessageBox MB_ICONSTOP|MB_OK "Nao foi possivel preparar a IA local do LetsWork. Verifique sua conexao com a internet e execute o instalador novamente."
      Abort
    ${endIf}
  ${endIf}
!macroend
