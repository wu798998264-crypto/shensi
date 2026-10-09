import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applyMainWindowTaskbarIdentity } from "../packaging/windows/desktop-app/taskbar-identity.mjs";

const calls = [];
const window = { isDestroyed: () => false, setAppDetails: (details) => calls.push(details) };
assert.equal(applyMainWindowTaskbarIdentity(window, { appId: "com.shensi.creativeengine", platform: "win32" }), true);
assert.deepEqual(calls, [{ appId: "com.shensi.creativeengine" }]);
assert.equal(applyMainWindowTaskbarIdentity(window, { appId: "com.shensi.creativeengine", platform: "darwin" }), false);
assert.equal(applyMainWindowTaskbarIdentity({ isDestroyed: () => true }, { platform: "win32" }), false);
assert.throws(() => applyMainWindowTaskbarIdentity(window, { platform: "win32" }), /缺少应用标识/u);
const source = await readFile(new URL("../packaging/windows/desktop-app/main.mjs", import.meta.url), "utf8");
const creation = source.slice(source.indexOf("const createMainWindowShell"), source.indexOf('mainWindow.webContents.setWindowOpenHandler', source.indexOf("const createMainWindowShell")));
assert.match(creation, /new BrowserWindow[\s\S]*applyMainWindowTaskbarIdentity\(mainWindow, \{ appId: APP_USER_MODEL_ID \}\)/u, "首次显示前必须绑定主窗口标识");
const restore = source.slice(source.indexOf("const showAndSynchronizeMainWindow"), source.indexOf("const showMainWindowFromBackground"));
assert.match(restore, /applyMainWindowTaskbarIdentity[\s\S]*setSkipTaskbar\(false\)[\s\S]*mainWindow\.show\(\)/u, "托盘恢复/重新显示必须保持神思窗口身份");
assert.doesNotMatch(await readFile(new URL("../packaging/windows/desktop-app/taskbar-identity.mjs", import.meta.url), "utf8"), /setOverlayIcon|setProgressBar|relaunchCommand|setBounds|setFullScreen/u, "不能用假状态点、进度条或改布局冒充修复");
console.log("Desktop main HWND taskbar identity contract passed");
