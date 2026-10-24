; Override the builder hook: its default implementation eventually kills the
; app. OneMount must flush writes and unmount through its own safe-exit flow.
!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    ; Upgrades must stay in the registered directory. Otherwise the old
    ; uninstaller would remove overrides which were not backed up from INSTDIR.
    ReadRegStr $R2 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $R2 != ""
      GetFullPathName $R2 "$R2"
      GetFullPathName $R3 "$INSTDIR"
      ${If} $R2 != $R3
        ${IfNot} ${Silent}
          MessageBox MB_OK|MB_ICONEXCLAMATION "升级时请使用原安装目录，避免丢失自定义网盘配置。$\r$\n$\r$\nUse the existing installation directory when upgrading to preserve custom storage settings."
        ${EndIf}
        SetErrorLevel 13
        Quit
      ${EndIf}
    ${EndIf}
  !endif
  InitPluginsDir
  File /oname=$PLUGINSDIR\onemount-check-running.ps1 "${BUILD_RESOURCES_DIR}\check-running.ps1"
  nsExec::ExecToStack /TIMEOUT=30000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\onemount-check-running.ps1" -InstallDirectory "$INSTDIR" -AppExecutable "${APP_EXECUTABLE_FILENAME}"'
  Pop $R0
  Pop $R1
  ${If} $R0 != 0
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "OneMount 或磁盘进程仍在运行，或无法确认退出状态。请在 OneMount 的设置中选择安全退出，等待文件上传和磁盘卸载完成后重试。安装程序不会强制结束进程。$\r$\n$\r$\nOneMount or a disk process is still running, or its status could not be verified. Use Safe Exit in OneMount, wait for uploads and unmounting, then retry."
    ${EndIf}
    SetErrorLevel 10
    Quit
  ${EndIf}
  !ifndef BUILD_UNINSTALLER
    ; The old uninstaller removes application files during upgrade. Keep exact
    ; bytes of deployment overrides in this installer's private temp directory.
    !insertmacro OneMountBackupConfig "provider-config.json"
    !insertmacro OneMountBackupConfig "oauth-clients.json"
  !endif
!macroend

!macro OneMountBackupConfig file
  ${If} ${FileExists} "$INSTDIR\${file}"
    ClearErrors
    CopyFiles /SILENT "$INSTDIR\${file}" "$PLUGINSDIR\saved-${file}"
    ${If} ${Errors}
      SetErrorLevel 12
      Abort "Cannot preserve existing ${file}. Installation has stopped."
    ${EndIf}
  ${EndIf}
!macroend

!macro OneMountRestoreConfig file
  ${If} ${FileExists} "$PLUGINSDIR\saved-${file}"
    ClearErrors
    CopyFiles /SILENT "$PLUGINSDIR\saved-${file}" "$INSTDIR\${file}"
    ${If} ${Errors}
      SetErrorLevel 12
      Abort "Cannot restore existing ${file}. Check installation permissions."
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  ; Embed defaults here instead of extraFiles: builder otherwise excludes the
  ; same source files from app.asar, where the runtime needs its fallback copy.
  File /oname=$INSTDIR\provider-config.json "${PROJECT_DIR}\provider-config.json"
  File /oname=$INSTDIR\oauth-clients.json "${PROJECT_DIR}\oauth-clients.json"
  !insertmacro OneMountRestoreConfig "provider-config.json"
  !insertmacro OneMountRestoreConfig "oauth-clients.json"
  ; A portable copy of win-unpacked never receives this marker.
  FileOpen $R0 "$INSTDIR\resources\install-mode.json" w
  FileWrite $R0 '{$\"kind$\":$\"nsis$\"}'
  FileClose $R0
!macroend
