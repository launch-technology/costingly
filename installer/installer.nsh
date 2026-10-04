; Costingly's additions to the Windows installer and uninstaller.
;
; TWO THINGS: what happens when Costingly is running, and a copy of the
; installer that would otherwise be left on the machine for good (at the end
; of this file).
;
; WHEN COSTINGLY IS RUNNING
;
; electron-builder's own step closes the app, and kills it if it does not go.
; For Costingly that is exactly wrong. Closing the window only hides it to the
; tray, so the app would be killed — and a killed app never stops its database.
; The database's programs live in this install folder, so they would still be
; running, their files would be locked, and the install or uninstall would
; fail half-way.
;
; So this replaces that step. It ASKS, and waits: the user quits Costingly from
; its tray icon, which stops the database cleanly, and clicks Retry. Nothing is
; ever terminated from here.
;
; It looks for Costingly's own program and for the database's, running from
; this install folder. The database is checked as well because it can be up
; with no app — after a crash — and the remedy is the same: open Costingly, and
; quit it properly.
;
; In a silent run (/S) there is nobody to ask, so the answer is Cancel and the
; installer exits without touching anything.

!macro customCheckAppRunning
  costingly_check_running:
    nsExec::Exec `"$PowerShellPath" -NoProfile -C "if ((Get-CimInstance -ClassName Win32_Process | ? { $$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') -and ($$_.Name -in @('${APP_EXECUTABLE_FILENAME}', 'postgres.exe', 'pg_ctl.exe')) }).Count -gt 0) { exit 0 } else { exit 1 }"`
    Pop $R0
    ${if} $R0 == 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${PRODUCT_NAME} is running.$\r$\n$\r$\nQuit it from its icon in the system tray (right-click the icon, then Quit), and click Retry.$\r$\n$\r$\nIf you cannot find the icon, open ${PRODUCT_NAME} from the Start menu first, then quit it." /SD IDCANCEL IDRETRY costingly_check_running
      Quit
    ${endIf}
!macroend

; THE INSTALLER'S COPY OF ITSELF
;
; electron-builder's installer saves a copy of itself — as large as the
; installer — under %LOCALAPPDATA%\costingly-updater, for an auto-updater to
; reuse. Costingly has no auto-updater, and the uninstaller never removes that
; copy, so it would outlive the app. This runs at the end of the install and
; deletes it. The folder is removed only if that leaves it empty.

!macro customInstall
  !ifdef APP_INSTALLER_STORE_FILE
    Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
    RMDir "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater"
  !endif
!macroend
