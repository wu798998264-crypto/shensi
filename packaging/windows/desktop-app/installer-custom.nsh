; 神思安装程序自定义NSIS脚本
; 1. 默认安装到 C 盘标准位置 %LOCALAPPDATA%\Programs\Shensi
;    Electron 在非系统盘(D:/E:)上无法正常初始化 Chromium 沙箱
;    用户数据通过 main.mjs 中的 machineLocalDataRoot 自动重定向到 D/E 盘
; 2. 可执行文件使用 ASCII 名称 Shensi.exe（通过 package.json executableName 设置）
; 3. 桌面快捷方式由 assisted NSIS 页面提供复选框，用户自行选择。
;    customInstall 只执行页面记录的选择，不得无条件创建。

!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER
Var ShensiDesktopShortcutCheckbox
Var ShensiCreateDesktopShortcut
!endif

!macro customInit
  ; 默认安装到 C 盘用户目录（Electron 标准位置）
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Shensi"
  ; 交互安装默认勾选，用户可以取消；静默安装沿用这个默认值。
  !ifndef BUILD_UNINSTALLER
  StrCpy $ShensiCreateDesktopShortcut ${BST_CHECKED}
  !endif
!macroend

!macro customPageAfterChangeDir
  Page custom ShensiShortcutPageCreate ShensiShortcutPageLeave
!macroend

; electron-builder 会先以 BUILD_UNINSTALLER 编译卸载器。安装页面函数不能进入
; 卸载器，否则 makensis 会将“函数未引用”警告视为构建错误。
!ifndef BUILD_UNINSTALLER
Function ShensiShortcutPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "快捷方式"
  Pop $0
  ${NSD_CreateCheckbox} 0 34u 100% 18u "创建桌面快捷方式"
  Pop $ShensiDesktopShortcutCheckbox
  ${NSD_SetState} $ShensiDesktopShortcutCheckbox $ShensiCreateDesktopShortcut
  nsDialogs::Show
FunctionEnd

Function ShensiShortcutPageLeave
  ${NSD_GetState} $ShensiDesktopShortcutCheckbox $ShensiCreateDesktopShortcut
FunctionEnd
!endif

!macro customInstall
  ${If} $ShensiCreateDesktopShortcut == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\神思.lnk" "$INSTDIR\Shensi.exe" "" "$INSTDIR\Shensi.exe" 0
    WinShell::SetLnkAUMI "$DESKTOP\神思.lnk" "${APP_ID}"
  ${Else}
    Delete "$DESKTOP\神思.lnk"
    Delete "$DESKTOP\Shensi.lnk"
  ${EndIf}
!macroend

!macro customUnInstall
  Delete "$DESKTOP\神思.lnk"
  Delete "$DESKTOP\Shensi.lnk"
  Delete "$SMPROGRAMS\神思.lnk"
  Delete "$SMPROGRAMS\Shensi.lnk"
!macroend
