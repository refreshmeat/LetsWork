param([string]$ProfilePath)
$rows = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*remote-debugging-port=9223*' -and $_.CommandLine -like ('*' + $ProfilePath + '*') }
$roots = $rows | Where-Object { $_.CommandLine -notlike '*--type=*' }
foreach($row in $roots){
  try{ & taskkill.exe /PID $row.ProcessId /T /F | Out-Null }catch{}
}
