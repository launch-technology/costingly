; Costingly's additions to the Windows installer and uninstaller.
;
; FOUR THINGS: what happens when Costingly is running, a copy of the
; installer that would otherwise be left on the machine for good, the
; start-at-sign-in registration, and the user's data folder on uninstall
; (the last three at the end of this file).
;
; One flag is shared between the first and the last: whether the user, asked
; by the uninstaller, agreed to have the data folder deleted. It is set only
; on the OK of that dialog, so an upgrade and a silent run can never delete.
; It is declared inside the uninstaller-only code: the installer is compiled
; without that code, and NSIS treats a variable nothing references as an error.
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
;
; THE DATA WARNING LIVES HERE TOO, for the uninstaller only. The one-click
; uninstaller shows its own "Are you sure?" and then calls this check; right
; after it, it switches itself to silent, and NSIS shows no dialog in silent
; mode. So this is the last moment a question can be put to the user, and the
; warning about the data folder is asked here, once the running check has
; passed. It is skipped when the uninstaller runs as part of an install over
; an existing copy (an upgrade keeps the data) and when it was started silent
; (nobody to ask, so the data stays). OK sets the flag the uninstall step
; reads; Cancel ends the uninstaller with nothing touched.

!macro customCheckAppRunning
  costingly_check_running:
    nsExec::Exec `"$PowerShellPath" -NoProfile -C "if ((Get-CimInstance -ClassName Win32_Process | ? { $$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') -and ($$_.Name -in @('${APP_EXECUTABLE_FILENAME}', 'postgres.exe', 'pg_ctl.exe')) }).Count -gt 0) { exit 0 } else { exit 1 }"`
    Pop $R0
    ${if} $R0 == 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${PRODUCT_NAME} is running.$\r$\n$\r$\nQuit it from its icon in the system tray (right-click the icon, then Quit), and click Retry.$\r$\n$\r$\nIf you cannot find the icon, open ${PRODUCT_NAME} from the Start menu first, then quit it." /SD IDCANCEL IDRETRY costingly_check_running
      Quit
    ${endIf}

  !ifdef __UNINSTALL__
    Var /GLOBAL costinglyDeleteData
    StrCpy $costinglyDeleteData "0"
    ${ifNot} ${isUpdated}
    ${andIfNot} ${Silent}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "Uninstalling ${PRODUCT_NAME} deletes everything it keeps on this computer: your database of transactions, your Plaid keys, and its settings and logs. This cannot be undone.$\r$\n$\r$\nAny banks still linked stay connected at Plaid, which may keep charging for them. To avoid that, click Cancel, open ${PRODUCT_NAME} and unlink each bank first.$\r$\n$\r$\nClick OK to uninstall and delete the data, or Cancel to keep everything as it is." /SD IDCANCEL IDOK costingly_delete_data
      Quit
      costingly_delete_data:
      StrCpy $costinglyDeleteData "1"
    ${endIf}
  !endif
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

; THE START-AT-SIGN-IN REGISTRATION
;
; The app's Settings screen can register Costingly to start when the user
; signs in to Windows. That is a value in the user's Run key, written by the
; app under the name below (src/apps/desktop/main/shell/start-at-sign-in.ts),
; and nothing in electron-builder knows about it. Left behind, Windows would
; try to start a program that is gone at every sign-in. So the uninstaller
; removes it. Deleting a value that is not there is not an error.
;
; NOT ON AN UPGRADE. Installing over an existing copy runs the old copy's
; uninstaller first, with this macro in it. The user's choice to start at
; sign-in must survive that, so the delete is skipped when the uninstaller is
; running as part of an install — the same test electron-builder's own data
; cleanup makes.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Costingly"
  ${endIf}

  ; THE DATA FOLDER
  ;
  ; Everything Costingly keeps for the user sits under one folder (see
  ; src/platform/app-dir.ts): %LOCALAPPDATA%\costingly, with Data\ (config,
  ; keys, database, log) and Desktop\ (the app's settings, the MCP token, the
  ; app log, the window cache). Deleting that one folder is the whole cleanup.
  ; Only when the user agreed to it above; the running check that precedes the
  ; dialog is what makes the delete safe, since no database program from this
  ; install is up to be using the folder.
  ;
  ; RMDir /r says nothing when it cannot finish. The uninstaller is silent by
  ; now, so a message would not show either; if anything is left, the folder
  ; is opened in Explorer so the user sees what remains and can remove it.
  ${if} $costinglyDeleteData == "1"
    RMDir /r "$LOCALAPPDATA\costingly"
    ${if} ${FileExists} "$LOCALAPPDATA\costingly\*.*"
      ExecShell "open" "$LOCALAPPDATA\costingly"
    ${endIf}
  ${endIf}
!macroend
