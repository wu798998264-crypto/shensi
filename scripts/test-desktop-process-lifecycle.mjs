import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../packaging/windows/desktop-app/main.mjs", import.meta.url), "utf8");

assert.match(source, /app\.requestSingleInstanceLock\(\)/u, "desktop must enforce one application instance");
assert.match(source, /app\.on\("second-instance"[\s\S]{0,900}showMainWindowFromBackground/u, "second launch must restore the existing main window");
assert.match(source, /mainWindow\.once\("ready-to-show",\s*showMainWindow\)/u, "production startup must show the main window when ready");
assert.match(source, /await loadApplicationPage\(\);\s*showMainWindow\(\);\s*desktopStartupComplete = true/u, "successful production startup must explicitly show the main window");
assert.match(source, /tray\.on\("click",\s*showMainWindowFromBackground\)/u, "tray click must restore the existing window");
assert.match(source, /tray\.on\("right-click",[\s\S]{0,160}popUpContextMenu/u, "tray right click must always open its context menu");
assert.match(source, /if \(mainWindow\.isMinimized\(\)\) mainWindow\.restore\(\)/u, "restoring the window must undo minimization");
assert.match(source, /mainWindow\.setSkipTaskbar\(false\)[\s\S]{0,180}mainWindow\.show\(\)[\s\S]{0,180}mainWindow\.maximize\(\)/u, "Windows restore must show before maximizing so Chromium receives the final size");
assert.match(source, /app\.setUserTasks\(\[/u, "Windows taskbar right click must expose application actions");
assert.match(source, /app\.on\("activate"[\s\S]{0,500}showMainWindowFromBackground/u, "application activation must restore the main window");
assert.match(source, /RENDERER_UNRESPONSIVE_GRACE_MS = Math\.max\(10_000,[\s\S]{0,120}\|\| 20_000\)/u, "renderer recovery must tolerate long-running document/media work");
assert.match(source, /writeDiagnosticLog\(`renderer unresponsive; graceMs=\$\{RENDERER_UNRESPONSIVE_GRACE_MS\}`\)/u, "renderer unresponsive state must be recorded");
assert.match(source, /writeDiagnosticLog\(`renderer process gone: reason=/u, "renderer termination reason must be recorded");
assert.match(source, /writeDiagnosticLog\("desktop before-quit"\)/u, "desktop shutdown requests must be recorded");
assert.match(source, /mainWindow\.on\("close"[\s\S]{0,700}requestApplicationQuit\(\{ rendererGraceMs: SYSTEM_CLOSE_GRACE_MS \}\)/u, "taskbar Close and Alt+F4 must request a real application quit");
assert.match(source, /ipcMain\.handle\("shensi:window:close"[\s\S]{0,500}target\.hide\(\)/u, "the custom title-bar close button must retain background/tray behavior");
assert.match(source, /shutdown watchdog elapsed[\s\S]{0,300}app\.exit\(0\)/u, "shutdown must have a bounded final exit watchdog");

console.log("Shensi desktop process lifecycle contract passed");
