import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../packaging/windows/desktop-app/main.mjs", import.meta.url), "utf8");

assert.match(source, /app\.requestSingleInstanceLock\(\)/u, "desktop must enforce one application instance");
assert.match(source, /app\.on\("second-instance"[\s\S]{0,900}showMainWindowFromBackground/u, "second launch must restore the existing main window");
assert.match(source, /mainWindow\.once\("ready-to-show",\s*showMainWindow\)/u, "production startup must show the main window when ready");
assert.match(source, /await loadApplicationPage\(\);\s*showMainWindow\(\);\s*desktopStartupComplete = true/u, "successful production startup must explicitly show the main window");
assert.match(source, /tray\.on\("click",\s*showMainWindowFromBackground\)/u, "tray click must restore the existing window");
assert.match(source, /tray\.setContextMenu\(contextMenu\)/u, "tray uses the native main-process context menu");
assert.doesNotMatch(source, /tray\.on\("right-click"/u, "native right-click must not open a second nested context menu");
assert.match(source, /if \(mainWindow\.isMinimized\(\)\) mainWindow\.restore\(\)/u, "restoring the window must undo minimization");
assert.match(source, /mainWindow\.setSkipTaskbar\(false\)[\s\S]{0,180}mainWindow\.show\(\)[\s\S]{0,180}mainWindow\.maximize\(\)/u, "Windows restore must show before maximizing so Chromium receives the final size");
assert.match(source, /app\.setUserTasks\(\[/u, "Windows taskbar right click must expose application actions");
assert.doesNotMatch(source, /arguments: "--shensi-quit"/u, "desktop lifecycle must not add a duplicate taskbar quit action");
assert.match(source, /mainWindow\.on\("close", \(event\) => \{[\s\S]{0,520}requestApplicationQuit\(\)/u, "native taskbar close must fully quit while the in-product close button remains tray-only");
assert.match(source, /process\.platform === "win32"[\s\S]{0,520}taskkill[\s\S]{0,220}\/T[\s\S]{0,120}\/F/u, "Windows shutdown must terminate the verified backend process tree");
const unresponsive = source.slice(source.indexOf('mainWindow.on("unresponsive"'), source.indexOf('mainWindow.on("responsive"'));
assert.doesNotMatch(unresponsive, /installWindowsTaskbarActions\(\)/u, "hang recovery must not synchronously call Windows Jump List COM");
assert.match(source, /rendererUnresponsive \? 2_000 : RENDERER_CLOSE_GRACE_MS/u, "explicit quit has bounded wait for a hung renderer");
assert.match(source, /app\.on\("activate"[\s\S]{0,500}showMainWindowFromBackground/u, "application activation must restore the main window");
assert.match(source, /RENDERER_UNRESPONSIVE_GRACE_MS = Math\.max\(10_000,[\s\S]{0,120}\|\| 20_000\)/u, "renderer recovery must tolerate long-running document/media work");
assert.match(source, /writeDiagnosticLog\(`renderer unresponsive; graceMs=\$\{RENDERER_UNRESPONSIVE_GRACE_MS\}`\)/u, "renderer unresponsive state must be recorded");
assert.match(source, /writeDiagnosticLog\(`renderer process gone: reason=/u, "renderer termination reason must be recorded");
assert.match(source, /writeDiagnosticLog\("desktop before-quit"\)/u, "desktop shutdown requests must be recorded");

console.log("Shensi desktop process lifecycle contract passed");
