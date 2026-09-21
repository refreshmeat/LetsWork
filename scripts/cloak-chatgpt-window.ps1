param([string]$ProfilePath)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class LetsWorkWin32 {
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@
$GWL_EXSTYLE = -20
$WS_EX_TOOLWINDOW = 0x00000080
$WS_EX_APPWINDOW = 0x00040000
$SWP_NOZORDER = 0x0004
$SWP_NOACTIVATE = 0x0010
$SWP_FRAMECHANGED = 0x0020
for($i=0;$i -lt 8;$i++){
  $rows = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*remote-debugging-port=9333*' -and $_.CommandLine -like ('*' + $ProfilePath + '*') }
  foreach($row in $rows){
    try{
      $p = Get-Process -Id $row.ProcessId -ErrorAction Stop
      $h = $p.MainWindowHandle
      if($h -ne 0){
        $style = [LetsWorkWin32]::GetWindowLongPtr($h,$GWL_EXSTYLE).ToInt64()
        $style = ($style -bor $WS_EX_TOOLWINDOW) -band (-bnot $WS_EX_APPWINDOW)
        [LetsWorkWin32]::SetWindowLongPtr($h,$GWL_EXSTYLE,[IntPtr]$style) | Out-Null
        [LetsWorkWin32]::SetWindowPos($h,[IntPtr]::Zero,-32000,-32000,800,600,($SWP_NOZORDER -bor $SWP_NOACTIVATE -bor $SWP_FRAMECHANGED)) | Out-Null
        [LetsWorkWin32]::ShowWindowAsync($h,0) | Out-Null
      }
    }catch{}
  }
  Start-Sleep -Milliseconds 250
}
