; The Windows installer (built in CI with: makensis /DVERSION=1.0.8 /DSOURCE=<dist\Binder> /DICON=<icon.ico> /DOUTFILE=<out.exe> installer.nsi).
;
; A per-user install (no administrator prompt) into %LOCALAPPDATA%\Programs\Binder, with a Start menu shortcut and an entry
; in Settings > Apps. Running it again over an existing install upgrades it in place; with /S it does that silently and
; starts the new version when done, which is how the app updates itself (src/updater.cpp). Everything the app writes (its
; collections, settings and card catalog) lives in the user's app-data folder, so installing, upgrading and uninstalling
; never touch it.
Unicode true
!include "MUI2.nsh"

Name "Binder"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Binder"
InstallDirRegKey HKCU "Software\Binder" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID zlib   ; the bundled models don't compress much, so favour a fast build over lzma

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\binder.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start Binder"

!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; A running copy has its files locked: close it first (this is also what lets the app's own update replace it).
Function .onInit
  nsExec::Exec 'taskkill /F /IM binder.exe'
  Pop $0
  Sleep 1000
FunctionEnd

Section "Binder"
  SetOutPath "$INSTDIR"
  ; drop the previous version's files so ones a newer version no longer ships don't linger
  RMDir /r "$INSTDIR\frontend"
  Delete "$INSTDIR\*.dll"
  File /r "${SOURCE}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateShortcut "$SMPROGRAMS\Binder.lnk" "$INSTDIR\binder.exe"
  WriteRegStr HKCU "Software\Binder" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Binder" "DisplayName" "Binder"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Binder" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Binder" "Publisher" "Binder"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Binder" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Binder" "DisplayIcon" "$INSTDIR\binder.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Binder" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Binder" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Binder" "NoRepair" 1

  ; a silent run is the app updating itself: start the new version (an interactive run offers it on the last page)
  IfSilent 0 +2
    Exec '"$INSTDIR\binder.exe"'
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM binder.exe'
  Pop $0
  Sleep 1000
  Delete "$SMPROGRAMS\Binder.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Binder"
  DeleteRegKey HKCU "Software\Binder"
SectionEnd
