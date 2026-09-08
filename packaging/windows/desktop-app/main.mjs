import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, safeStorage, screen, session, shell, Tray } from "electron";
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { request } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCredentialVault } from "./credential-vault.mjs";
import { directoryDialogOptions, resolveDirectoryDialogDefaultPath } from "./directory-dialog.mjs";
import { nextAvailableMediaSavePath, sanitizeSuggestedMediaName } from "./media-save-name.mjs";

const PRODUCT_NAME_ZH = "神思";
const PRODUCT_NAME_EN = "神思";
const APP_USER_MODEL_ID = "com.shensi.creativeengine";
const LOOPBACK_HOST = "127.0.0.1";
// A first launch after an upgrade may need to verify and snapshot a multi-GB
// user library before the local HTTP core can listen. Keep the ordinary fast
// path unchanged, but do not misreport a healthy protected migration as a
// startup failure after only 30 seconds.
const STARTUP_TIMEOUT_MS = Math.max(30_000, Number(process.env.SHENSI_STARTUP_TIMEOUT_MS) || 300_000);
const INITIAL_BACKEND_START_MAX_ATTEMPTS = 4;
const BACKEND_RESTART_MAX_ATTEMPTS = 3;
const BACKEND_RESTART_BASE_DELAY_MS = Math.max(100, Number(process.env.SHENSI_BACKEND_RESTART_BASE_DELAY_MS) || 750);
const BACKEND_RESTART_MAX_DELAY_MS = 6_000;
const BACKEND_STABLE_RESET_MS = Math.max(10_000, Number(process.env.SHENSI_BACKEND_STABLE_RESET_MS) || 60_000);
const RENDERER_RECOVERY_MAX_ATTEMPTS = 3;
// Long document rendering and media previews can briefly block Chromium's
// renderer. Give the surface enough time to recover before replacing it.
const RENDERER_UNRESPONSIVE_GRACE_MS = Math.max(10_000, Number(process.env.SHENSI_RENDERER_UNRESPONSIVE_GRACE_MS) || 20_000);
const RENDERER_CLOSE_GRACE_MS = Math.max(4_000, Number(process.env.SHENSI_RENDERER_CLOSE_GRACE_MS) || 12_000);
const WINDOW_STATE_FILE = "desktop-window-state.json";
const MIN_WINDOW_WIDTH = 1120;
const MIN_WINDOW_HEIGHT = 720;
const here = dirname(fileURLToPath(import.meta.url));
const developmentRoot = resolve(here, "..", "..", "..");
const configuredInstallRoot = String(process.env.SHENSI_INSTALL_ROOT || "").trim();
const installed = Boolean(configuredInstallRoot) || app.isPackaged;
const installRoot = configuredInstallRoot
  ? resolve(configuredInstallRoot)
  : installed
    ? resolve(process.resourcesPath, "..", "..")
    : developmentRoot;
// When packaged with electron-builder using ASAR, resources are inside
// process.resourcesPath/app.asar (accessed as a virtual directory).
// When packaged with electron-builder without ASAR, resources are at
// process.resourcesPath/app/ (standard electron-builder output).
// When using portable staging, resources are at installRoot/app/core.
const asarAppRoot = join(process.resourcesPath, "app.asar");
const electronBuilderAppRoot = join(process.resourcesPath, "app");
const portableAppRoot = join(installRoot, "app", "core");
const appRoot = installed
  ? (existsSync(asarAppRoot) ? asarAppRoot
    : existsSync(join(electronBuilderAppRoot, "server.mjs")) ? electronBuilderAppRoot
    : existsSync(join(portableAppRoot, "server.mjs")) ? portableAppRoot
    : electronBuilderAppRoot)
  : developmentRoot;
const serverEntry = join(appRoot, "server.mjs");
const preloadPath = join(here, "preload.cjs");
// Keep the in-product brand mark untouched. The desktop shell uses the
// transparent, rounded Windows icon so the taskbar never shows a sharp tile.
const logoPath = join(appRoot, "public", "assets", "shensi-app-icon.png");
const recoveryLogoDataUrl = existsSync(logoPath)
  ? `data:image/png;base64,${readFileSync(logoPath).toString("base64")}`
  : "";
const machineLocalDataRoot = resolve(
  String(process.env.SHENSI_MACHINE_DATA_ROOT || "").trim()
    || (process.platform === "win32"
      ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "ShensiCreativeEngine")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support", "ShensiCreativeEngine")
        : join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "shensi-creative-engine")),
);
// The server's machineLocalDataRoot() must resolve to the same path as the
// data root so the startup data version guard can find the version marker.
// On Windows, the default data root is E:\ShensiUserData (from app-data.mjs).
// Read bootstrap.json to get the configured data root, falling back to the
// default if the file doesn't exist yet.
const explicitServerDataRoot = String(process.env.SHENSI_DATA_ROOT || process.env.SHENSI_MACHINE_DATA_ROOT || "").trim();
const defaultServerDataRoot = explicitServerDataRoot
  ? resolve(explicitServerDataRoot)
  : process.platform === "win32"
    ? resolve("E:\\ShensiUserData")
    : machineLocalDataRoot;
let serverMachineDataRoot = defaultServerDataRoot;
try {
  const bootstrap = JSON.parse(readFileSync(join(defaultServerDataRoot, "bootstrap.json"), "utf8"));
  if (bootstrap?.dataRoot) serverMachineDataRoot = resolve(bootstrap.dataRoot);
} catch { /* bootstrap.json doesn't exist yet, use default */ }
const legacyElectronUserDataRoot = join(machineLocalDataRoot, "DesktopRuntime");
const defaultElectronUserDataRoot = join(dirname(machineLocalDataRoot), `${basename(machineLocalDataRoot)}-DesktopRuntime`);
let electronUserDataRoot = resolve(
  String(process.env.SHENSI_DESKTOP_USER_DATA_ROOT || "").trim() || defaultElectronUserDataRoot,
);
// The protected creative-data root must be renameable during an interrupted
// update rollback. Chromium keeps LevelDB/session files locked for the entire
// desktop lifetime, so migrate its disposable runtime (plus the encrypted
// desktop credential vault and window state) to a sibling directory before
// Electron opens any handles. A concurrent legacy instance can keep the old
// path locked; in that one exceptional case use it for this short-lived second
// instance so the existing single-instance hand-off still works.
if (!process.env.SHENSI_DESKTOP_USER_DATA_ROOT
  && electronUserDataRoot !== resolve(legacyElectronUserDataRoot)
  && !existsSync(electronUserDataRoot)
  && existsSync(legacyElectronUserDataRoot)) {
  try {
    renameSync(legacyElectronUserDataRoot, electronUserDataRoot);
  } catch (error) {
    if (!["EACCES", "EBUSY", "EPERM"].includes(error?.code)) throw error;
    electronUserDataRoot = resolve(legacyElectronUserDataRoot);
  }
}
const electronSessionRoot = join(electronUserDataRoot, "Session");
const electronCacheRoot = join(electronSessionRoot, "Cache");
for (const target of [electronUserDataRoot, electronSessionRoot, electronCacheRoot]) mkdirSync(target, { recursive: true });
app.setPath("userData", electronUserDataRoot);
app.setPath("sessionData", electronSessionRoot);

app.setName(PRODUCT_NAME_ZH);
app.setAppUserModelId(APP_USER_MODEL_ID);
if (/^(?:1|true)$/i.test(String(process.env.SHENSI_DISABLE_HARDWARE_ACCELERATION || ""))) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  app.commandLine.appendSwitch("disable-features", "Vulkan,Dawn");
  if (/^(?:1|true)$/i.test(String(process.env.SHENSI_TEST_DESKTOP_RUNTIME || ""))) app.commandLine.appendSwitch("no-sandbox");
}
app.commandLine.appendSwitch("disk-cache-dir", electronCacheRoot);
app.commandLine.appendSwitch("disk-cache-size", String(128 * 1024 * 1024));

const credentialVault = createCredentialVault({
  root: electronUserDataRoot,
  encryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (value) => safeStorage.encryptString(value),
  decryptString: (value) => safeStorage.decryptString(value),
});

let mainWindow = null;
let mainWindowShown = false;
let tray = null;
let backendProcess = null;
let backendOrigin = "";
let sessionToken = "";
let backendStartupNonce = "";
let quitting = false;
let windowStateTimer = null;
let backendErrorTail = "";
let rendererApprovedClose = false;
let explicitQuitRequested = false;
let backendReadyProcess = null;
let backendRecoveryPromise = null;
let backendRestartAttempts = 0;
let backendStabilityTimer = null;
let rendererRecoveryPromise = null;
let rendererRecoveryAttempts = 0;
let rendererUnresponsiveTimer = null;
let rendererUnresponsive = false;
let rendererCloseTimer = null;
let recoveryPageActive = false;
let recoveryPageUrl = "";
let controlledNavigationUrl = "";
let desktopStartupComplete = false;
let lastMediaSaveDirectory = "";
let externalMarkdownRendererReady = false;
let externalMarkdownDrainPromise = null;
const pendingExternalMarkdownPaths = [];
const pendingExternalMarkdownPayloads = [];
const expectedBackendStops = new WeakSet();

const RECOVERY_RETRY_URL = "shensi-recovery://retry";
const RECOVERY_EXIT_URL = "shensi-recovery://exit";
const RECOVERY_MINIMIZE_URL = "shensi-recovery://window/minimize";
const RECOVERY_MAXIMIZE_URL = "shensi-recovery://window/maximize";
const RECOVERY_CLOSE_URL = "shensi-recovery://window/close";

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

const markdownPathsFromArguments = (argumentsList, workingDirectory = process.cwd()) => {
  const base = isAbsolute(String(workingDirectory || "")) ? resolve(workingDirectory) : process.cwd();
  const found = [];
  const seen = new Set();
  for (const argument of argumentsList || []) {
    const raw = String(argument || "").trim();
    if (!raw || raw.startsWith("--") || !/\.md$/i.test(raw)) continue;
    const candidate = isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
    const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(candidate);
  }
  return found;
};

const queueExternalMarkdownArguments = (argumentsList, workingDirectory = process.cwd()) => {
  for (const filePath of markdownPathsFromArguments(argumentsList, workingDirectory)) {
    const key = process.platform === "win32" ? filePath.toLowerCase() : filePath;
    if (!pendingExternalMarkdownPaths.some((item) => (process.platform === "win32" ? item.toLowerCase() : item) === key)) {
      pendingExternalMarkdownPaths.push(filePath);
    }
  }
};

queueExternalMarkdownArguments(process.argv.slice(1), process.cwd());

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

// Chromium's child surface does not receive the final WM_SIZE event when a
// hidden frameless BrowserWindow is maximized before it is shown on Windows.
// The outer HWND then fills the screen while the renderer remains at the
// persisted normal bounds (for example 1440x900), leaving a blank area. Always
// make the window visible before applying a maximized state. When restoring a
// previously hidden maximized window, briefly return it to its normal state
// while hidden so the following maximize produces a fresh child-surface resize.
const showAndSynchronizeMainWindow = ({ focus = true } = {}) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const wasHidden = !mainWindow.isVisible();
  const shouldMaximize = mainWindow.isMaximized() || mainWindow._savedWindowState?.maximized === true;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (wasHidden && mainWindow.isMaximized()) mainWindow.unmaximize();
  mainWindow.setSkipTaskbar(false);
  mainWindow.show();
  if (shouldMaximize && !mainWindow.isMaximized()) mainWindow.maximize();
  if (focus) mainWindow.focus();
  publishWindowState(mainWindow);
  return true;
};

const showMainWindowFromBackground = () => {
  return showAndSynchronizeMainWindow();
};

const openSettingsFromBackground = () => {
  if (!showMainWindowFromBackground() || recoveryPageActive) return false;
  const sendRequest = () => {
    if (!mainWindow || mainWindow.isDestroyed() || recoveryPageActive) return;
    mainWindow.webContents.send("shensi:open-settings");
  };
  if (mainWindow.webContents.isLoadingMainFrame()) mainWindow.webContents.once("did-finish-load", sendRequest);
  else sendRequest();
  return true;
};

const finishApplicationQuit = () => {
  rendererApprovedClose = true;
  app.quit();
};

const requestApplicationQuit = () => {
  if (quitting || explicitQuitRequested) return;
  explicitQuitRequested = true;
  if (!mainWindow || mainWindow.isDestroyed() || recoveryPageActive) {
    finishApplicationQuit();
    return;
  }
  mainWindow.webContents.send("shensi:prepare-close");
  clearTimeout(rendererCloseTimer);
  rendererCloseTimer = setTimeout(() => {
    rendererCloseTimer = null;
    console.error("[shensi-desktop-quit-timeout] renderer did not acknowledge tray exit; using the durable recovery checkpoint");
    finishApplicationQuit();
  }, RENDERER_CLOSE_GRACE_MS);
  rendererCloseTimer.unref?.();
};

const createApplicationTray = () => {
  if (tray) return tray;
  const chinese = /^zh(?:-|$)/i.test(app.getLocale());
  const labels = chinese
    ? { open: "打开神思", settings: "设置", quit: "退出神思" }
    : { open: "Open 神思", settings: "Settings", quit: "Quit 神思" };
  const sourceIcon = nativeImage.createFromPath(logoPath);
  if (sourceIcon.isEmpty()) throw new Error("圆角神思托盘图标无法读取");
  const trayIcon = process.platform === "win32" ? sourceIcon.resize({ width: 24, height: 24, quality: "best" }) : sourceIcon;
  tray = new Tray(trayIcon);
  tray.setToolTip(`${PRODUCT_NAME_ZH} ${app.getVersion()}`);
  const contextMenu = Menu.buildFromTemplate([
    { label: labels.open, click: showMainWindowFromBackground },
    { label: labels.settings, click: openSettingsFromBackground },
    { type: "separator" },
    { label: labels.quit, click: requestApplicationQuit },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on("click", showMainWindowFromBackground);
  tray.on("double-click", showMainWindowFromBackground);
  tray.on("right-click", () => tray?.popUpContextMenu(contextMenu));
  return tray;
};

const installWindowsTaskbarActions = () => {
  if (process.platform !== "win32") return;
  const chinese = /^zh(?:-|$)/i.test(app.getLocale());
  app.setUserTasks([
    {
      program: process.execPath,
      arguments: "",
      iconPath: process.execPath,
      iconIndex: 0,
      title: chinese ? "打开神思" : "Open Shensi",
      description: chinese ? "显示现有神思主窗口" : "Show the existing Shensi window",
    },
    {
      program: process.execPath,
      arguments: "--open-settings",
      iconPath: process.execPath,
      iconIndex: 0,
      title: chinese ? "神思设置" : "Shensi Settings",
      description: chinese ? "打开现有神思窗口并进入设置" : "Open Shensi and show Settings",
    },
  ]);
};

const constantTimeEqual = (left, right) => {
  const leftBytes = Buffer.from(String(left || ""), "utf8");
  const rightBytes = Buffer.from(String(right || ""), "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

const startupNonceProof = (nonce, pid) => createHash("sha256")
  .update(`shensi-desktop-startup:${pid}:${nonce}`, "utf8")
  .digest("base64url");

const reserveLoopbackPort = async () => {
  const minimum = 20_000;
  const span = 25_000;
  let lastError = null;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const port = minimum + randomBytes(2).readUInt16BE(0) % span;
    try {
      return await new Promise((resolvePort, rejectPort) => {
        const probe = createServer();
        probe.unref();
        probe.once("error", rejectPort);
        probe.listen(port, LOOPBACK_HOST, () => {
          probe.close((error) => error ? rejectPort(error) : resolvePort(port));
        });
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("没有找到可用的本地服务端口");
};

const httpRequest = (url, { method = "GET", headers = {}, timeout = 1_500, body = null } = {}) => new Promise((resolveRequest, rejectRequest) => {
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  const outgoing = request(url, { method, headers: { ...headers, ...(payload ? { "Content-Length": String(payload.length) } : {}) }, timeout }, (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => resolveRequest({
      statusCode: Number(response.statusCode || 0),
      text: Buffer.concat(chunks).toString("utf8"),
    }));
  });
  outgoing.once("timeout", () => outgoing.destroy(new Error("request timed out")));
  outgoing.once("error", rejectRequest);
  if (payload) outgoing.write(payload);
  outgoing.end();
});

const postBackendJson = async (pathname, value) => {
  if (!backendOrigin || !sessionToken) throw new Error("本地核心尚未就绪");
  const result = await httpRequest(`${backendOrigin}${pathname}`, {
    method: "POST",
    headers: { "X-Shensi-Session": sessionToken, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(value || {}),
    timeout: 10_000,
  });
  let payload = {};
  try { payload = JSON.parse(result.text || "{}"); } catch {}
  if (result.statusCode < 200 || result.statusCode >= 300 || payload.ok === false) throw new Error(String(payload.message || `本地核心请求失败（HTTP ${result.statusCode}）`));
  return payload;
};

const publishExternalMarkdownPayload = (payload) => {
  if (externalMarkdownRendererReady && mainWindow && !mainWindow.isDestroyed() && !recoveryPageActive) {
    mainWindow.webContents.send("shensi:external-markdown-opened", payload);
    return;
  }
  pendingExternalMarkdownPayloads.push(payload);
};

const drainExternalMarkdownPaths = async () => {
  if (externalMarkdownDrainPromise) return externalMarkdownDrainPromise;
  if (!backendOrigin || !sessionToken) return false;
  externalMarkdownDrainPromise = (async () => {
    while (pendingExternalMarkdownPaths.length && backendOrigin && sessionToken && !quitting) {
      const filePath = pendingExternalMarkdownPaths.shift();
      try {
        const payload = await postBackendJson("/api/external-markdown/open", { filePath });
        publishExternalMarkdownPayload({ ...payload, filePath });
      } catch (error) {
        publishExternalMarkdownPayload({ ok: false, filePath, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return true;
  })().finally(() => { externalMarkdownDrainPromise = null; });
  return externalMarkdownDrainPromise;
};

const readStoredNutstoreCredential = async () => {
  const { records = {} } = await credentialVault.readChannel("nutstore_webdav");
  try {
    const value = JSON.parse(String(records.default || "{}"));
    if (!value.account || !value.password) return null;
    return { account: String(value.account), password: String(value.password) };
  } catch { return null; }
};

const restoreNutstoreCredentialSession = async () => {
  const value = await readStoredNutstoreCredential();
  if (!value) return { restored: false };
  await postBackendJson("/api/sync/nutstore/session-credentials", value);
  return { restored: true, account: value.account };
};

const backendHealthMatches = (payload, child, nonce) => {
  const expectedPid = Number(child?.pid || 0);
  const expectedProof = startupNonceProof(nonce, expectedPid);
  return payload?.service === "shensi-local"
    && payload?.ok === true
    && Number(payload?.pid) === expectedPid
    && payload?.desktopLifecycle?.managed === true
    && constantTimeEqual(payload?.startupNonceProof, expectedProof);
};

const waitForBackend = async (child, origin, nonce) => {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child?.exitCode != null) throw new Error(`本地核心提前退出（代码 ${child.exitCode}）。${backendErrorTail}`);
    try {
      const health = await httpRequest(`${origin}/api/health`);
      if (health.statusCode === 200) {
        const payload = JSON.parse(health.text);
        if (backendHealthMatches(payload, child, nonce)) return payload;
      }
    } catch {}
    await delay(120);
  }
  throw new Error(`本地核心在 ${Math.round(STARTUP_TIMEOUT_MS / 1000)} 秒内未能启动。${backendErrorTail}`);
};

const resolveNodeExecutable = () => {
  if (installed) {
    const bundledNode = join(process.resourcesPath, "node.exe");
    if (existsSync(bundledNode)) return bundledNode;
    return process.execPath;
  }
  return String(process.env.npm_node_execpath || process.env.SHENSI_NODE_EXECUTABLE || "node");
};

const clearBackendStabilityTimer = () => {
  clearTimeout(backendStabilityTimer);
  backendStabilityTimer = null;
};

const scheduleBackendStabilityReset = (child) => {
  clearBackendStabilityTimer();
  backendStabilityTimer = setTimeout(() => {
    if (quitting || backendReadyProcess !== child || child.exitCode != null) return;
    backendRestartAttempts = 0;
    backendStabilityTimer = null;
  }, BACKEND_STABLE_RESET_MS);
  backendStabilityTimer.unref?.();
};

const handleUnexpectedBackendExit = (child, code, signal) => {
  if (expectedBackendStops.has(child) || quitting || backendReadyProcess !== child) return;
  backendReadyProcess = null;
  if (backendProcess === child) backendProcess = null;
  sessionToken = "";
  backendOrigin = "";
  backendStartupNonce = "";
  clearBackendStabilityTimer();
  const exitReason = code == null ? `信号 ${signal || "unknown"}` : `代码 ${code}`;
  backendErrorTail = `${backendErrorTail}\n本地核心意外退出（${exitReason}）。`.slice(-6_000);
  console.error(`[shensi-desktop-backend-exit] ${exitReason}`);
  void recoverBackend(`本地核心意外退出（${exitReason}）`);
};

const writeDiagnosticLog = (message) => {
  try {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}\n`;
    // Startup logs are runtime diagnostics, not creative business data. Keep
    // one machine-local copy so installs never scatter logs across drives,
    // the install parent, and the user's home directory.
    const logDirs = [machineLocalDataRoot];
    for (const dir of logDirs) {
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, "desktop-startup.log"), line);
      } catch {}
    }
  } catch {}
};

const startBackend = async () => {
  const port = await reserveLoopbackPort();
  backendOrigin = `http://${LOOPBACK_HOST}:${port}`;
  backendStartupNonce = randomBytes(32).toString("base64url");
  sessionToken = "";
  backendErrorTail = "";
  const nodeExecutable = resolveNodeExecutable();
  const usingBundledNode = nodeExecutable !== process.execPath;
  const agentProjectRoot = resolve(String(process.env.SHENSI_AGENT_PROJECT_ROOT || "").trim() || join(app.getPath("documents"), "神思"));
  mkdirSync(agentProjectRoot, { recursive: true });
  // ASAR 路径不能作为 cwd（OS 层 chdir 不识别虚拟目录），使用真实目录替代
  const backendCwd = appRoot.includes(".asar") ? installRoot : appRoot;
  const child = spawn(nodeExecutable, [serverEntry, "--host", LOOPBACK_HOST, "--port", String(port)], {
    cwd: backendCwd,
    env: {
      ...process.env,
      ...(usingBundledNode ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
      SHENSI_DESKTOP_RUNTIME: "electron",
      SHENSI_DESKTOP_PARENT_PID: String(process.pid),
      SHENSI_DESKTOP_STARTUP_NONCE: backendStartupNonce,
      SHENSI_INSTALL_ROOT: installRoot,
      SHENSI_AGENT_PROJECT_ROOT: agentProjectRoot,
      SHENSI_MACHINE_DATA_ROOT: serverMachineDataRoot,
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  backendProcess = child;
  const rememberBackendOutput = (chunk) => {
    if (backendProcess === child) backendErrorTail = `${backendErrorTail}${chunk.toString("utf8")}`.slice(-6_000);
  };
  child.stdout?.on("data", rememberBackendOutput);
  child.stderr?.on("data", rememberBackendOutput);
  child.once("error", (err) => { rememberBackendOutput(err); writeDiagnosticLog(`spawn error: ${err?.message || err}`); });
  child.once("exit", (code, signal) => { writeDiagnosticLog(`child exit: code=${code} signal=${signal}`); handleUnexpectedBackendExit(child, code, signal); });
  writeDiagnosticLog(`spawned: exe=${nodeExecutable} usingBundledNode=${usingBundledNode} entry=${serverEntry} cwd=${backendCwd} installed=${installed} appRoot=${appRoot}`);
  await waitForBackend(child, backendOrigin, backendStartupNonce);
  const page = await httpRequest(`${backendOrigin}/`);
  sessionToken = page.text.match(/name="shensi-session-token" content="([^"]+)"/)?.[1] || "";
  if (!sessionToken) throw new Error("本地核心未返回桌面会话令牌。");
  if (child.exitCode != null) throw new Error(`本地核心在页面加载前退出（代码 ${child.exitCode}）。${backendErrorTail}`);
  backendReadyProcess = child;
  await restoreNutstoreCredentialSession().catch((error) => {
    console.error("[shensi-nutstore-credential-restore]", String(error?.message || error));
  });
  scheduleBackendStabilityReset(child);
};

const startInitialBackend = async () => {
  let lastError = null;
  for (let attempt = 1; attempt <= INITIAL_BACKEND_START_MAX_ATTEMPTS; attempt += 1) {
    try {
      writeDiagnosticLog(`startInitialBackend attempt=${attempt}`);
      await startBackend();
      writeDiagnosticLog(`startInitialBackend success on attempt=${attempt}`);
      return;
    } catch (error) {
      lastError = error;
      writeDiagnosticLog(`startInitialBackend failed attempt=${attempt}: ${error?.message || error}`);
      writeDiagnosticLog(`backendErrorTail: ${backendErrorTail}`);
      console.error(`[shensi-desktop-initial-backend-failed] attempt=${attempt}`, error);
      await stopBackend();
      if (attempt < INITIAL_BACKEND_START_MAX_ATTEMPTS) {
        await delay(Math.min(BACKEND_RESTART_BASE_DELAY_MS * attempt, BACKEND_RESTART_MAX_DELAY_MS));
      }
    }
  }
  throw lastError || new Error("本地核心首次启动失败。");
};

const stopBackend = async () => {
  const child = backendProcess;
  const origin = backendOrigin;
  const token = sessionToken;
  if (child) expectedBackendStops.add(child);
  backendProcess = null;
  if (backendReadyProcess === child) backendReadyProcess = null;
  backendOrigin = "";
  backendStartupNonce = "";
  sessionToken = "";
  clearBackendStabilityTimer();
  if (!child || child.exitCode != null) return;
  try {
    await httpRequest(`${origin}/api/runtime/shutdown`, {
      method: "POST",
      headers: token ? { "X-Shensi-Session": token } : {},
      timeout: 1_200,
    });
  } catch {}
  if (child.exitCode != null) return;
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
    delay(5_000).then(() => false),
  ]);
  if (!exited && child.exitCode == null) child.kill();
};

const windowStatePath = () => join(app.getPath("userData"), WINDOW_STATE_FILE);

const clampWindowStateToVisibleWorkArea = (value = {}) => {
  const requestedWidth = Math.max(MIN_WINDOW_WIDTH, Math.min(3840, Number(value.width) || 1440));
  const requestedHeight = Math.max(MIN_WINDOW_HEIGHT, Math.min(2160, Number(value.height) || 900));
  const hasPosition = Number.isFinite(value.x) && Number.isFinite(value.y);
  const candidate = {
    x: hasPosition ? Math.round(value.x) : 0,
    y: hasPosition ? Math.round(value.y) : 0,
    width: Math.round(requestedWidth),
    height: Math.round(requestedHeight),
  };
  const display = hasPosition ? screen.getDisplayMatching(candidate) : screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const width = Math.max(1, Math.min(candidate.width, workArea.width));
  const height = Math.max(1, Math.min(candidate.height, workArea.height));
  const centeredX = workArea.x + Math.floor((workArea.width - width) / 2);
  const centeredY = workArea.y + Math.floor((workArea.height - height) / 2);
  const x = Math.min(Math.max(hasPosition ? candidate.x : centeredX, workArea.x), workArea.x + workArea.width - width);
  const y = Math.min(Math.max(hasPosition ? candidate.y : centeredY, workArea.y), workArea.y + workArea.height - height);
  return {
    x,
    y,
    width,
    height,
    minWidth: Math.min(MIN_WINDOW_WIDTH, workArea.width),
    minHeight: Math.min(MIN_WINDOW_HEIGHT, workArea.height),
    maximized: value.maximized === true,
  };
};

const loadWindowState = async () => {
  try {
    const value = JSON.parse(await readFile(windowStatePath(), "utf8"));
    return clampWindowStateToVisibleWorkArea(value);
  } catch {
    return clampWindowStateToVisibleWorkArea();
  }
};

const persistWindowState = async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const maximized = mainWindow.isMaximized();
  const bounds = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
  await writeFile(windowStatePath(), `${JSON.stringify({ ...bounds, maximized }, null, 2)}\n`, "utf8").catch(() => {});
};

const scheduleWindowStateSave = () => {
  clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(() => void persistWindowState(), 250);
};

const windowForEvent = (event) => BrowserWindow.fromWebContents(event.sender) || mainWindow;

const isTrustedRendererIpcEvent = (event) => {
  if (!mainWindow
    || mainWindow.isDestroyed()
    || event?.sender !== mainWindow.webContents
    || !backendOrigin) return false;
  try {
    const senderUrl = String(event.senderFrame?.url || event.sender.getURL() || "");
    return new URL(senderUrl).origin === backendOrigin;
  } catch {
    return false;
  }
};

const trustedIpcHandler = (channel, handler) => (event, ...args) => {
  if (!isTrustedRendererIpcEvent(event)) {
    console.warn(`[shensi-desktop-ipc] rejected untrusted sender for ${channel}`);
    throw new Error("桌面能力仅允许神思本地可信界面调用");
  }
  return handler(event, ...args);
};

const publishWindowState = (target = mainWindow) => {
  if (!target || target.isDestroyed()) return;
  target.webContents.send("shensi:window-state", {
    maximized: target.isMaximized(),
    fullscreen: target.isFullScreen(),
  });
};

const WINDOWS_FILE_DROP_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$manifestPath = [Environment]::GetEnvironmentVariable('SHENSI_CLIPBOARD_MANIFEST')
if ([string]::IsNullOrWhiteSpace($manifestPath) -or -not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw 'Clipboard manifest is missing.'
}
$payload = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$paths = @($payload.paths | ForEach-Object { [IO.Path]::GetFullPath([string]$_) })
if ($paths.Count -lt 1) { throw 'Clipboard file list is empty.' }
$files = New-Object System.Collections.Specialized.StringCollection
foreach ($path in $paths) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Clipboard source file is missing: $path" }
  [void]$files.Add($path)
}
$data = New-Object System.Windows.Forms.DataObject
$data.SetFileDropList($files)
if ($null -ne $payload.text -and -not [string]::IsNullOrEmpty([string]$payload.text)) {
  $data.SetText([string]$payload.text, [System.Windows.Forms.TextDataFormat]::UnicodeText)
}
$bitmap = $null
if ($null -ne $payload.imagePath -and -not [string]::IsNullOrWhiteSpace([string]$payload.imagePath)) {
  $imagePath = [IO.Path]::GetFullPath([string]$payload.imagePath)
  if (Test-Path -LiteralPath $imagePath -PathType Leaf) {
    $sourceImage = [System.Drawing.Image]::FromFile($imagePath)
    try { $bitmap = New-Object System.Drawing.Bitmap $sourceImage } finally { $sourceImage.Dispose() }
    $data.SetImage($bitmap)
  }
}
try {
  [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 10, 100)
  $written = [System.Windows.Forms.Clipboard]::GetFileDropList()
  if ($written.Count -ne $paths.Count) { throw 'Windows clipboard file count did not match.' }
  for ($index = 0; $index -lt $paths.Count; $index += 1) {
    if ([IO.Path]::GetFullPath([string]$written[$index]) -ne $paths[$index]) { throw 'Windows clipboard file verification failed.' }
  }
} finally {
  if ($null -ne $bitmap) { $bitmap.Dispose() }
}
`;

const runWindowsFileDropClipboard = async ({ paths = [], text = "", imagePath = "", manifestPath = "" } = {}) => {
  if (process.platform !== "win32") throw new Error("当前桌面系统不支持 Windows 文件剪贴板");
  const normalizedPaths = [...new Set(paths.map((sourcePath) => resolve(String(sourcePath || ""))).filter(Boolean))];
  if (!normalizedPaths.length) throw new Error("没有可写入系统剪贴板的卡片文件");
  await writeFile(manifestPath, `${JSON.stringify({ paths: normalizedPaths, text: String(text || ""), imagePath: String(imagePath || "") }, null, 2)}\n`, "utf8");
  const encodedCommand = Buffer.from(WINDOWS_FILE_DROP_SCRIPT, "utf16le").toString("base64");
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, SHENSI_CLIPBOARD_MANIFEST: manifestPath },
    });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      rejectRun(new Error("Windows 文件剪贴板写入超时"));
    }, 20_000);
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveRun();
      else rejectRun(new Error(stderr.trim() || `Windows 文件剪贴板写入失败（退出码 ${code}）`));
    });
  });
  return normalizedPaths;
};

const WINDOWS_READ_FILE_DROP_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$paths = @([System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { [IO.Path]::GetFullPath([string]$_) })
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
@($paths) | ConvertTo-Json -Compress
`;

const readWindowsFileDropClipboard = async () => {
  if (process.platform !== "win32") return [];
  const encodedCommand = Buffer.from(WINDOWS_READ_FILE_DROP_SCRIPT, "utf16le").toString("base64");
  const output = await new Promise((resolveRun, rejectRun) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      rejectRun(new Error("Windows 文件剪贴板读取超时"));
    }, 8_000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveRun(stdout.trim());
      else rejectRun(new Error(stderr.trim() || `Windows 文件剪贴板读取失败（退出码 ${code}）`));
    });
  });
  if (!output) return [];
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(String).filter(Boolean).slice(0, 100);
};

const clipboardCardFileName = (card = {}, index = 0) => {
  const firstLine = String(card.text || "").split(/\r?\n/u).map((line) => line.trim()).find(Boolean) || "";
  const safeName = sanitizeSuggestedMediaName(card.name || firstLine || `白板卡片-${index + 1}`);
  return /\.[a-z\d]{1,10}$/iu.test(safeName) ? safeName : `${safeName}.md`;
};

const prepareWhiteboardClipboardFiles = async ({ workspacePath = "", cards = [] } = {}) => {
  const normalizedCards = Array.isArray(cards) ? cards.slice(0, 100) : [];
  if (!normalizedCards.length) throw new Error("没有可复制的白板卡片");
  const workspaceRoot = workspacePath && isAbsolute(workspacePath) ? resolve(workspacePath) : "";
  const batchRoot = join(app.getPath("temp"), "ShensiCreativeEngine", "ClipboardCards", `${Date.now()}-${randomBytes(6).toString("hex")}`);
  mkdirSync(batchRoot, { recursive: true });
  const paths = [];
  let clipboardText = "";
  let imagePath = "";
  let textBytes = 0;
  for (const [index, card] of normalizedCards.entries()) {
    const relativePath = String(card?.relativePath || "").trim();
    if (relativePath) {
      if (!workspaceRoot || isAbsolute(relativePath)) throw new Error("白板媒体附件路径无效");
      const sourcePath = resolve(workspaceRoot, relativePath);
      const sourceRelative = relative(workspaceRoot, sourcePath);
      if (!sourceRelative || sourceRelative.startsWith("..") || isAbsolute(sourceRelative)) throw new Error("白板媒体附件超出当前工作区");
      const sourceInfo = await stat(sourcePath).catch(() => null);
      if (!sourceInfo?.isFile() || sourceInfo.size <= 0) throw new Error(`卡片媒体尚未完整落盘：${basename(sourcePath)}`);
      paths.push(sourcePath);
      if (normalizedCards.length === 1 && card.kind === "image") imagePath = sourcePath;
      continue;
    }
    const text = String(card?.text || "");
    textBytes += Buffer.byteLength(text, "utf8");
    if (textBytes > 16 * 1024 * 1024) throw new Error("复制的卡片文字超过 16MB 安全上限");
    const targetPath = await nextAvailableMediaSavePath({
      directory: batchRoot,
      suggestedName: clipboardCardFileName(card, index),
      exists: async (candidatePath) => Boolean(await stat(candidatePath).catch(() => null)),
    });
    await writeFile(targetPath, text, "utf8");
    paths.push(targetPath);
    if (normalizedCards.length === 1) clipboardText = text;
  }
  if (!paths.length) throw new Error("卡片没有可复制的内容");
  return { paths, clipboardText, imagePath, manifestPath: join(batchRoot, "clipboard-manifest.json") };
};

const installWindowBridge = () => {
  ipcMain.handle("shensi:external-markdown:renderer-ready", trustedIpcHandler("shensi:external-markdown:renderer-ready", async () => {
    externalMarkdownRendererReady = true;
    await drainExternalMarkdownPaths();
    return { ok: true, opened: pendingExternalMarkdownPayloads.splice(0) };
  }));
  ipcMain.handle("shensi:credentials:read-generation", trustedIpcHandler("shensi:credentials:read-generation", async () => ({ ok: true, ...(await credentialVault.read()) })));
  ipcMain.handle("shensi:credentials:write-generation", trustedIpcHandler("shensi:credentials:write-generation", async (_event, payload = {}) => ({
    ok: true,
    ...(await credentialVault.update((current) => ({ ...current, ...(payload?.secrets ?? {}), ...(current.nutstore_webdav ? { nutstore_webdav: current.nutstore_webdav } : {}) }))),
  })));
  ipcMain.handle("shensi:credentials:nutstore-status", trustedIpcHandler("shensi:credentials:nutstore-status", async () => {
    const value = await readStoredNutstoreCredential();
    return { ok: true, configured: Boolean(value), account: value?.account || "" };
  }));
  ipcMain.handle("shensi:credentials:nutstore-store", trustedIpcHandler("shensi:credentials:nutstore-store", async (_event, payload = {}) => {
    const account = String(payload.account || "").trim().slice(0, 320);
    const password = String(payload.password || "").slice(0, 1024);
    if (!account || !password) throw new Error("坚果云账号和第三方应用密码不能为空");
    await credentialVault.writeChannel("nutstore_webdav", { default: JSON.stringify({ account, password }) });
    await postBackendJson("/api/sync/nutstore/session-credentials", { account, password });
    return { ok: true, stored: true, account };
  }));
  ipcMain.handle("shensi:credentials:nutstore-clear", trustedIpcHandler("shensi:credentials:nutstore-clear", async () => {
    await credentialVault.deleteChannel("nutstore_webdav");
    await postBackendJson("/api/sync/nutstore/session-credentials", { account: "", password: "" }).catch(() => {});
    return { ok: true, stored: false };
  }));
  ipcMain.handle("shensi:window:minimize", trustedIpcHandler("shensi:window:minimize", (event) => {
    const target = windowForEvent(event);
    target?.minimize();
    return true;
  }));
  ipcMain.handle("shensi:window:toggle-maximize", trustedIpcHandler("shensi:window:toggle-maximize", (event) => {
    const target = windowForEvent(event);
    if (!target) return { maximized: false, fullscreen: false };
    if (target.isMaximized()) target.unmaximize();
    else target.maximize();
    publishWindowState(target);
    return { maximized: target.isMaximized(), fullscreen: target.isFullScreen() };
  }));
  ipcMain.handle("shensi:window:is-maximized", trustedIpcHandler("shensi:window:is-maximized", (event) => {
    const target = windowForEvent(event);
    return { maximized: target?.isMaximized() === true, fullscreen: target?.isFullScreen() === true };
  }));
  ipcMain.handle("shensi:window:set-fullscreen", trustedIpcHandler("shensi:window:set-fullscreen", (event, active) => {
    const target = windowForEvent(event);
    if (!target || target.isDestroyed()) return { maximized: false, fullscreen: false };
    target.setFullScreen(active === true);
    publishWindowState(target);
    return { maximized: target.isMaximized(), fullscreen: target.isFullScreen() };
  }));
  ipcMain.handle("shensi:window:is-fullscreen", trustedIpcHandler("shensi:window:is-fullscreen", (event) => {
    const target = windowForEvent(event);
    return { fullscreen: target?.isFullScreen() === true, maximized: target?.isMaximized() === true };
  }));
  ipcMain.handle("shensi:window:get-state", trustedIpcHandler("shensi:window:get-state", (event) => {
    const target = windowForEvent(event);
    if (!target || target.isDestroyed()) return null;
    return {
      bounds: target.getBounds(),
      maximized: target.isMaximized(),
      fullscreen: target.isFullScreen(),
      minimized: target.isMinimized(),
      visible: target.isVisible(),
    };
  }));
  ipcMain.handle("shensi:window:close", trustedIpcHandler("shensi:window:close", (event) => {
    const target = windowForEvent(event);
    if (!target || target.isDestroyed()) return { hidden: false, background: true };
    void persistWindowState();
    target.hide();
    return { hidden: true, background: true };
  }));
  ipcMain.handle("shensi:application:quit", trustedIpcHandler("shensi:application:quit", () => {
    requestApplicationQuit();
    return true;
  }));
  ipcMain.handle("shensi:window:confirm-close", trustedIpcHandler("shensi:window:confirm-close", (event, saved) => {
    const target = windowForEvent(event);
    if (saved === true && explicitQuitRequested) {
      clearTimeout(rendererCloseTimer);
      rendererCloseTimer = null;
      finishApplicationQuit();
    } else if (saved === true) {
      target?.hide();
    } else {
      explicitQuitRequested = false;
      target?.show();
      target?.focus();
    }
    return saved === true;
  }));
  ipcMain.handle("shensi:path:reveal", trustedIpcHandler("shensi:path:reveal", async (_event, payload = {}) => {
    const source = String(payload.targetPath || "").trim();
    if (!source || !isAbsolute(source)) throw new Error("本地路径无效");
    const targetPath = resolve(source);
    const info = await stat(targetPath).catch(() => null);
    if (!info) throw new Error("本地文件或文件夹不存在");
    const selectFile = payload.selectFile === true && info.isFile();
    if (selectFile) {
      shell.showItemInFolder(targetPath);
    } else {
      const directoryPath = info.isDirectory() ? targetPath : dirname(targetPath);
      const errorMessage = await shell.openPath(directoryPath);
      if (errorMessage) throw new Error(errorMessage);
    }
    return { ok: true, targetPath, selectFile };
  }));
  ipcMain.handle("shensi:path:open", trustedIpcHandler("shensi:path:open", async (_event, payload = {}) => {
    const source = String(payload.targetPath || "").trim();
    if (!source || !isAbsolute(source)) throw new Error("本地路径无效");
    const targetPath = resolve(source);
    const info = await stat(targetPath).catch(() => null);
    if (!info?.isFile()) throw new Error("本地文件不存在");
    const errorMessage = await shell.openPath(targetPath);
    if (errorMessage) throw new Error(errorMessage);
    return { ok: true, targetPath };
  }));
  ipcMain.handle("shensi:path:select-directory", trustedIpcHandler("shensi:path:select-directory", async (event, payload = {}) => {
    const workspaceKind = payload.kind === "notebook" ? "notebook" : payload.kind === "agent" ? "agent" : "project";
    const defaultPath = await resolveDirectoryDialogDefaultPath(payload.defaultPath);
    const choice = await dialog.showOpenDialog(windowForEvent(event), directoryDialogOptions({ kind: workspaceKind, defaultPath }));
    if (choice.canceled || !choice.filePaths[0]) return { ok: false, canceled: true, path: "" };
    const selectedPath = resolve(choice.filePaths[0]);
    const info = await stat(selectedPath).catch(() => null);
    if (!info?.isDirectory()) throw new Error("所选导入目录不存在或不是文件夹");
    return { ok: true, canceled: false, path: selectedPath };
  }));
  ipcMain.handle("shensi:clipboard:write-text", trustedIpcHandler("shensi:clipboard:write-text", (_event, payload = {}) => {
    const text = String(payload.text ?? "");
    if (Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024) throw new Error("剪贴板文字超过 4MB 安全上限");
    clipboard.writeText(text);
    return { ok: true };
  }));
  ipcMain.handle("shensi:clipboard:read-text", trustedIpcHandler("shensi:clipboard:read-text", () => {
    const text = clipboard.readText();
    if (Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024) throw new Error("剪贴板文字超过 4MB 安全上限");
    return { ok: true, text };
  }));
  ipcMain.handle("shensi:clipboard:write-workspace-image", trustedIpcHandler("shensi:clipboard:write-workspace-image", async (_event, payload = {}) => {
    const workspacePath = String(payload.workspacePath || "").trim();
    const relativePath = String(payload.relativePath || "").trim();
    if (!workspacePath || !relativePath || !isAbsolute(workspacePath) || isAbsolute(relativePath)) {
      throw new Error("图片附件路径无效");
    }
    const workspaceRoot = resolve(workspacePath);
    const sourcePath = resolve(workspaceRoot, relativePath);
    const sourceRelative = relative(workspaceRoot, sourcePath);
    if (!sourceRelative || sourceRelative.startsWith("..") || isAbsolute(sourceRelative)) {
      throw new Error("图片附件必须位于当前工作区内");
    }
    const sourceInfo = await stat(sourcePath).catch(() => null);
    if (!sourceInfo?.isFile() || sourceInfo.size <= 0) throw new Error("图片源文件不存在或尚未完整落盘");
    if (sourceInfo.size > 128 * 1024 * 1024) throw new Error("图片过大，无法安全写入系统剪贴板");
    const image = nativeImage.createFromPath(sourcePath);
    if (image.isEmpty()) throw new Error("图片文件无法解码，未写入系统剪贴板");
    const dimensions = image.getSize();
    if (dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width > 32_768 || dimensions.height > 32_768) {
      throw new Error("图片尺寸异常，未写入系统剪贴板");
    }
    clipboard.writeImage(image);
    const written = clipboard.readImage();
    if (written.isEmpty()) throw new Error("Windows 剪贴板没有确认图片写入");
    return { ok: true, width: dimensions.width, height: dimensions.height };
  }));
  ipcMain.handle("shensi:clipboard:write-workspace-file", trustedIpcHandler("shensi:clipboard:write-workspace-file", async (_event, payload = {}) => {
    const workspacePath = String(payload.workspacePath || "").trim();
    const relativePath = String(payload.relativePath || "").trim();
    if (!workspacePath || !relativePath || !isAbsolute(workspacePath) || isAbsolute(relativePath)) {
      throw new Error("媒体附件路径无效");
    }
    const workspaceRoot = resolve(workspacePath);
    const sourcePath = resolve(workspaceRoot, relativePath);
    const sourceRelative = relative(workspaceRoot, sourcePath);
    if (!sourceRelative || sourceRelative.startsWith("..") || isAbsolute(sourceRelative)) throw new Error("媒体附件超出工作区");
    const sourceInfo = await stat(sourcePath).catch(() => null);
    if (!sourceInfo?.isFile() || sourceInfo.size <= 0) throw new Error("媒体源文件不存在或尚未完整落盘");
    const clipboardRoot = join(app.getPath("temp"), "ShensiCreativeEngine", "ClipboardCards", `${Date.now()}-${randomBytes(6).toString("hex")}`);
    mkdirSync(clipboardRoot, { recursive: true });
    await runWindowsFileDropClipboard({ paths: [sourcePath], manifestPath: join(clipboardRoot, "clipboard-manifest.json") });
    return { ok: true, fileName: sourcePath.split(/[\\/]/).at(-1) || "" };
  }));
  ipcMain.handle("shensi:clipboard:write-whiteboard-card-files", trustedIpcHandler("shensi:clipboard:write-whiteboard-card-files", async (_event, payload = {}) => {
    const prepared = await prepareWhiteboardClipboardFiles({
      workspacePath: String(payload.workspacePath || "").trim(),
      cards: Array.isArray(payload.cards) ? payload.cards : [],
    });
    const paths = await runWindowsFileDropClipboard({
      paths: prepared.paths,
      text: prepared.clipboardText,
      imagePath: prepared.imagePath,
      manifestPath: prepared.manifestPath,
    });
    return {
      ok: true,
      count: paths.length,
      fileNames: paths.map((sourcePath) => basename(sourcePath)),
    };
  }));
  ipcMain.handle("shensi:clipboard:read-files", trustedIpcHandler("shensi:clipboard:read-files", async () => {
    const paths = await readWindowsFileDropClipboard();
    const files = [];
    let totalBytes = 0;
    for (const sourcePath of paths) {
      const info = await stat(sourcePath).catch(() => null);
      if (!info?.isFile() || info.size <= 0 || info.size > 256 * 1024 * 1024) continue;
      totalBytes += info.size;
      if (totalBytes > 512 * 1024 * 1024) throw new Error("剪贴板文件总大小超过 512MB，无法一次导入");
      files.push({ name: basename(sourcePath), bytes: await readFile(sourcePath), size: info.size });
    }
    return { ok: true, files };
  }));
  ipcMain.handle("shensi:clipboard:read-image", trustedIpcHandler("shensi:clipboard:read-image", () => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return { ok: false, empty: true };
    const dimensions = image.getSize();
    if (dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width > 32_768 || dimensions.height > 32_768) {
      throw new Error("剪贴板图片尺寸异常");
    }
    const bytes = image.toPNG();
    if (!bytes.length || bytes.length > 128 * 1024 * 1024) throw new Error("剪贴板图片过大，无法安全导入");
    return { ok: true, bytes, width: dimensions.width, height: dimensions.height, mimeType: "image/png" };
  }));
  ipcMain.handle("shensi:file:save-workspace-media", trustedIpcHandler("shensi:file:save-workspace-media", async (event, payload = {}) => {
    const workspacePath = String(payload.workspacePath || "").trim();
    const relativePath = String(payload.relativePath || "").trim();
    if (!workspacePath || !relativePath || !isAbsolute(workspacePath) || isAbsolute(relativePath)) {
      throw new Error("媒体附件路径无效");
    }
    const workspaceRoot = resolve(workspacePath);
    const sourcePath = resolve(workspaceRoot, relativePath);
    const sourceRelative = relative(workspaceRoot, sourcePath);
    if (!sourceRelative || sourceRelative.startsWith("..") || isAbsolute(sourceRelative)) {
      throw new Error("媒体附件必须位于当前工作区内");
    }
    const sourceInfo = await stat(sourcePath).catch(() => null);
    if (!sourceInfo?.isFile() || sourceInfo.size <= 0) throw new Error("媒体源文件不存在或尚未完整落盘");
    const kind = ["image", "audio"].includes(payload.kind) ? payload.kind : "video";
    const kindLabel = kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";
    const suggestedName = sanitizeSuggestedMediaName(payload.suggestedName || sourcePath.split(/[\\/]/).at(-1) || `神思${kindLabel}`);
    const extension = suggestedName.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase() || (kind === "image" ? ".png" : kind === "video" ? ".mp4" : ".mp3");
    const mimeType = String(payload.mimeType || (kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "audio/mpeg"));
    const defaultPath = await nextAvailableMediaSavePath({
      directory: lastMediaSaveDirectory || app.getPath("downloads"),
      suggestedName,
      exists: async (targetPath) => Boolean(await stat(targetPath).catch(() => null)),
    });
    const choice = await dialog.showSaveDialog(windowForEvent(event), {
      title: `另存为${kindLabel}`,
      defaultPath,
      filters: [{ name: `${kindLabel}文件`, extensions: [extension.slice(1)] }, { name: "所有文件", extensions: ["*"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    });
    if (choice.canceled || !choice.filePath) return { ok: false, canceled: true };
    const destinationPath = resolve(choice.filePath);
    lastMediaSaveDirectory = dirname(destinationPath);
    if (destinationPath === sourcePath) return { ok: true, canceled: false, fileName: suggestedName, bytes: sourceInfo.size, mimeType };
    await copyFile(sourcePath, destinationPath);
    const destinationInfo = await stat(destinationPath).catch(() => null);
    if (!destinationInfo?.isFile() || destinationInfo.size !== sourceInfo.size) {
      throw new Error("另存为后的文件大小校验失败，请重试");
    }
    return { ok: true, canceled: false, fileName: destinationPath.split(/[\\/]/).at(-1) || suggestedName, bytes: destinationInfo.size, mimeType };
  }));
  ipcMain.handle("shensi:file:save-binary", trustedIpcHandler("shensi:file:save-binary", async (event, payload = {}) => {
    const bytes = Buffer.from(payload.bytes || []);
    if (!bytes.length) throw new Error("导出内容为空");
    if (bytes.length > 256 * 1024 * 1024) throw new Error("导出文件超过 256 MB，请缩小导出范围");
    const suggestedName = String(payload.suggestedName || "神思导出")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "")
      .trim()
      .slice(0, 140) || "神思导出";
    const extension = suggestedName.match(/\.([a-z0-9]{1,12})$/i)?.[1]?.toLowerCase() || "bin";
    const formatLabel = ({ docx: "WPS / Word 文档", md: "Markdown 文档", zip: "压缩包", html: "白板分享网页" })[extension] || "文件";
    const choice = await dialog.showSaveDialog(windowForEvent(event), {
      title: "导出",
      defaultPath: suggestedName,
      filters: [{ name: formatLabel, extensions: [extension] }, { name: "所有文件", extensions: ["*"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    });
    if (choice.canceled || !choice.filePath) return { ok: false, canceled: true };
    const destinationPath = resolve(choice.filePath);
    await writeFile(destinationPath, bytes);
    const destinationInfo = await stat(destinationPath).catch(() => null);
    if (!destinationInfo?.isFile() || destinationInfo.size !== bytes.length) throw new Error("导出文件写入校验失败，请重试");
    return {
      ok: true,
      canceled: false,
      fileName: destinationPath.split(/[\\/]/).at(-1) || suggestedName,
      bytes: destinationInfo.size,
      mimeType: String(payload.mimeType || "application/octet-stream"),
    };
  }));
  ipcMain.handle("shensi:file:save-text", trustedIpcHandler("shensi:file:save-text", async (event, payload = {}) => {
    const content = String(payload.content || "");
    if (!content.trim()) throw new Error("导出内容为空");
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (contentBytes > 128 * 1024 * 1024) throw new Error("对话记录超过 128 MB，请拆分后导出");
    const suggestedName = String(payload.suggestedName || "神思对话记录.md")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "")
      .trim()
      .slice(0, 120) || "神思对话记录.md";
    const fileName = /\.md$/i.test(suggestedName) ? suggestedName : `${suggestedName}.md`;
    const choice = await dialog.showSaveDialog(windowForEvent(event), {
      title: "导出完整对话记录",
      defaultPath: fileName,
      filters: [{ name: "Markdown 文档", extensions: ["md"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    });
    if (choice.canceled || !choice.filePath) return { ok: false, canceled: true };
    const destinationPath = resolve(choice.filePath);
    await writeFile(destinationPath, content, "utf8");
    const destinationInfo = await stat(destinationPath).catch(() => null);
    if (!destinationInfo?.isFile() || destinationInfo.size !== contentBytes) throw new Error("对话记录写入校验失败，请重试");
    return { ok: true, canceled: false, fileName: destinationPath.split(/[\\/]/).at(-1) || fileName, bytes: destinationInfo.size, mimeType: "text/markdown" };
  }));
};

const safeExternalUrl = (rawUrl) => {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "https:" || parsed.protocol === "mailto:" ? parsed.toString() : "";
  } catch {
    return "";
  }
};

const escapeHtml = (value) => String(value || "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const buildRecoveryPageUrl = ({ phase = "restarting", reason = "", attempt = 0, maxAttempts = 0 } = {}) => {
  const failed = phase === "failed";
  const renderer = phase === "renderer";
  const starting = phase === "starting";
  const heading = failed ? "神思本地核心暂时无法恢复" : renderer ? "正在恢复桌面界面" : starting ? "正在启动神思" : "正在恢复神思本地核心";
  const explanation = failed
    ? "自动恢复次数已经用完。你的作品仍保存在本机，可以手动重试或安全退出后重新打开。"
    : renderer
      ? "桌面界面发生异常，神思正在重新建立安全连接。"
      : starting
        ? "首次启动需要准备本地创作环境，请稍候片刻。"
        : "检测到本地核心意外中断，神思会在有限次数内自动重启，不会重复提交模型任务。";
  const progress = starting ? "正在启动本地核心" : attempt > 0 && maxAttempts > 0 ? `恢复尝试 ${attempt} / ${maxAttempts}` : "正在检查本地状态";
  const actions = failed
    ? `<nav class="recovery-actions"><a href="${RECOVERY_RETRY_URL}">重新尝试</a><a class="secondary" href="${RECOVERY_EXIT_URL}">退出应用</a></nav>`
    : "";
  const html = `<!doctype html>
<html lang="zh-CN" data-shensi-recovery-state="${escapeHtml(phase)}" data-shensi-recovery-attempt="${Number(attempt) || 0}">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(PRODUCT_NAME_ZH)} · 恢复中</title>
  <style>
    :root { color-scheme: light; font-family: "Microsoft YaHei UI", "PingFang SC", sans-serif; background: #f4f1eb; color: #28241f; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding-top: 42px; background: radial-gradient(circle at 50% 20%, #fff 0, #f4f1eb 48%, #ebe5db 100%); -webkit-app-region: drag; }
    .startup-window-bar { position: fixed; inset: 0 0 auto; height: 42px; display: flex; align-items: center; justify-content: space-between; padding-left: 16px; border-bottom: 1px solid rgba(80,70,58,.12); background: rgba(250,248,244,.92); }
    .startup-window-bar strong { font-size: 13px; font-weight: 600; }
    .startup-window-controls { align-self: stretch; display: flex; -webkit-app-region: no-drag; }
    .startup-window-controls a { display: grid; width: 46px; height: 100%; padding: 0; place-items: center; border-radius: 0; background: transparent; color: #413b34; font: 400 16px/1 "Segoe UI Symbol", sans-serif; }
    .startup-window-controls a:hover { background: rgba(55,48,40,.09); }
    .startup-window-controls a.close:hover { background: #c42b1c; color: #fff; }
    main { width: min(620px, calc(100vw - 56px)); padding: 46px; border: 1px solid #d8d0c4; border-radius: 20px; background: rgba(255,255,255,.92); box-shadow: 0 24px 70px rgba(60,48,33,.12); }
    .mark { width: 52px; height: 52px; display: block; border-radius: 14px; object-fit: cover; box-shadow: 0 5px 16px rgba(36,32,27,.14); }
    h1 { margin: 24px 0 12px; font: 600 25px/1.35 Georgia, "Microsoft YaHei UI", sans-serif; }
    p { margin: 0; color: #655e55; font-size: 15px; line-height: 1.8; }
    .progress { margin-top: 26px; padding: 13px 16px; border-radius: 10px; background: #f1eee8; color: #403a33; font-weight: 600; }
    .detail { margin-top: 14px; font-size: 13px; overflow-wrap: anywhere; }
    .recovery-actions { display: flex; gap: 12px; margin-top: 28px; -webkit-app-region: no-drag; }
    .recovery-actions a { padding: 11px 20px; border-radius: 9px; background: #24201b; color: #fff; text-decoration: none; font-weight: 600; }
    .recovery-actions a.secondary { background: #ece7df; color: #3e3831; }
    small { display: block; margin-top: 28px; color: #8a8176; }
  </style>
</head>
<body><header class="startup-window-bar"><strong>神思</strong><div class="startup-window-controls" aria-label="窗口控制"><a href="${RECOVERY_MINIMIZE_URL}" aria-label="最小化" title="最小化">−</a><a href="${RECOVERY_MAXIMIZE_URL}" aria-label="最大化或还原" title="最大化或还原">□</a><a class="close" href="${RECOVERY_CLOSE_URL}" aria-label="关闭" title="关闭">×</a></div></header><main>
  ${recoveryLogoDataUrl ? `<img class="mark" src="${recoveryLogoDataUrl}" alt="神思">` : ""}
  <h1>${escapeHtml(heading)}</h1>
  <p>${escapeHtml(explanation)}</p>
  <div class="progress">${escapeHtml(progress)}</div>
  ${reason ? `<p class="detail">${escapeHtml(String(reason).slice(0, 800))}</p>` : ""}
  ${actions}
  <small>神思 ${escapeHtml(app.getVersion())}</small>
</main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
};

const controlledLoadURL = async (url) => {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error("桌面窗口已关闭。");
  controlledNavigationUrl = url;
  try {
    await mainWindow.loadURL(url);
  } finally {
    if (controlledNavigationUrl === url) controlledNavigationUrl = "";
  }
};

const showRecoveryPage = async (state) => {
  if (!mainWindow || mainWindow.isDestroyed() || quitting) return false;
  recoveryPageActive = true;
  recoveryPageUrl = buildRecoveryPageUrl(state);
  const phaseLabel = state?.phase === "failed" ? "需要处理" : state?.phase === "starting" ? "启动中" : "恢复中";
  mainWindow.setTitle(`${PRODUCT_NAME_ZH} · ${phaseLabel}`);
  mainWindow.setProgressBar(2, { mode: "indeterminate" });
  await controlledLoadURL(recoveryPageUrl);
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  return true;
};

const loadApplicationPage = async () => {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error("桌面窗口已关闭。");
  const expectedChild = backendReadyProcess;
  const expectedOrigin = backendOrigin;
  if (!expectedChild || expectedChild.exitCode != null) throw new Error("本地核心尚未就绪。");
  await controlledLoadURL(`${expectedOrigin}/`);
  if (backendReadyProcess !== expectedChild || expectedChild.exitCode != null) throw new Error("页面加载期间本地核心再次退出。");
  recoveryPageActive = false;
  recoveryPageUrl = "";
  rendererRecoveryAttempts = 0;
  rendererUnresponsive = false;
  clearTimeout(rendererUnresponsiveTimer);
  rendererUnresponsiveTimer = null;
  mainWindow.setTitle(`${PRODUCT_NAME_ZH} ${app.getVersion()}`);
  mainWindow.setProgressBar(-1);
  publishWindowState();
};

const isBackendHealthy = async () => {
  const child = backendReadyProcess;
  if (!child || backendProcess !== child || child.exitCode != null || !backendOrigin || !backendStartupNonce) return false;
  try {
    const health = await httpRequest(`${backendOrigin}/api/health`);
    if (health.statusCode !== 200) return false;
    return backendHealthMatches(JSON.parse(health.text), child, backendStartupNonce);
  } catch {
    return false;
  }
};

async function recoverBackend(reason, { resetBudget = false } = {}) {
  if (quitting) return false;
  if (resetBudget) backendRestartAttempts = 0;
  if (backendRecoveryPromise) return backendRecoveryPromise;
  backendRecoveryPromise = (async () => {
    clearBackendStabilityTimer();
    let lastError = reason;
    while (!quitting && backendRestartAttempts < BACKEND_RESTART_MAX_ATTEMPTS) {
      const attempt = ++backendRestartAttempts;
      const retryDelay = Math.min(BACKEND_RESTART_BASE_DELAY_MS * (2 ** (attempt - 1)), BACKEND_RESTART_MAX_DELAY_MS);
      await showRecoveryPage({ phase: "restarting", reason: lastError, attempt, maxAttempts: BACKEND_RESTART_MAX_ATTEMPTS }).catch((error) => {
        console.error("[shensi-desktop-recovery-page]", error);
      });
      await delay(retryDelay);
      if (quitting) return false;
      try {
        await startBackend();
        await loadApplicationPage();
        console.log(`[shensi-desktop-backend-recovered] attempt=${attempt}`);
        return true;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        console.error(`[shensi-desktop-backend-restart-failed] attempt=${attempt}`, error);
        await stopBackend();
      }
    }
    await showRecoveryPage({
      phase: "failed",
      reason: `${lastError || reason} 自动恢复已停止，避免持续崩溃循环。`,
      attempt: backendRestartAttempts,
      maxAttempts: BACKEND_RESTART_MAX_ATTEMPTS,
    }).catch(async (error) => {
      console.error("[shensi-desktop-recovery-page-failed]", error);
      await dialog.showMessageBox({
        type: "error",
        title: PRODUCT_NAME_ZH,
        message: "本地核心无法恢复",
        detail: String(lastError || reason || error),
        buttons: ["确定"],
        noLink: true,
      });
    });
    return false;
  })().finally(() => {
    backendRecoveryPromise = null;
  });
  return backendRecoveryPromise;
}

async function recoverRendererSurface(reason, { resetBudget = false } = {}) {
  if (quitting || !desktopStartupComplete || !mainWindow || mainWindow.isDestroyed()) return false;
  if (resetBudget) rendererRecoveryAttempts = 0;
  if (rendererRecoveryPromise) return rendererRecoveryPromise;
  rendererRecoveryPromise = (async () => {
    await showRecoveryPage({ phase: "renderer", reason }).catch((error) => {
      console.error("[shensi-desktop-renderer-recovery-page]", error);
    });
    if (!await isBackendHealthy()) return recoverBackend(reason);
    let lastError = reason;
    while (!quitting && rendererRecoveryAttempts < RENDERER_RECOVERY_MAX_ATTEMPTS) {
      const attempt = ++rendererRecoveryAttempts;
      await delay(Math.min(250 * (2 ** (attempt - 1)), 1_500));
      try {
        await loadApplicationPage();
        console.log(`[shensi-desktop-renderer-recovered] attempt=${attempt}`);
        return true;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    await showRecoveryPage({
      phase: "failed",
      reason: `${lastError} 桌面界面自动恢复已停止。`,
      attempt: rendererRecoveryAttempts,
      maxAttempts: RENDERER_RECOVERY_MAX_ATTEMPTS,
    }).catch((error) => console.error("[shensi-desktop-renderer-failed]", error));
    return false;
  })().finally(() => {
    rendererRecoveryPromise = null;
  });
  return rendererRecoveryPromise;
}

const retryDesktopRecovery = async () => {
  backendRestartAttempts = 0;
  rendererRecoveryAttempts = 0;
  if (await isBackendHealthy()) return recoverRendererSurface("用户要求重新加载桌面界面。", { resetBudget: true });
  await stopBackend();
  return recoverBackend("用户要求重新启动本地核心。", { resetBudget: true });
};

const showMainWindow = () => {
  if (mainWindowShown || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindowShown = true;
  showAndSynchronizeMainWindow();
};

const createMainWindowShell = async () => {
  const saved = await loadWindowState();
  mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    minWidth: saved.minWidth,
    minHeight: saved.minHeight,
    show: false,
    frame: false,
    title: `${PRODUCT_NAME_ZH} ${app.getVersion()}`,
    icon: logoPath,
    backgroundColor: "#e8e8e8",
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
      devTools: !installed || process.env.SHENSI_ENABLE_DEVTOOLS === "1",
      additionalArguments: [
        "--shensi-desktop-shell",
        `--shensi-app-version=${app.getVersion()}`,
      ],
    },
  });

  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const external = safeExternalUrl(url);
    if (external) void shell.openExternal(external);
    return { action: "deny" };
  });
  mainWindow.webContents.on("did-start-loading", () => {
    externalMarkdownRendererReady = false;
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url === RECOVERY_MINIMIZE_URL) {
      event.preventDefault();
      mainWindow.minimize();
      return;
    }
    if (url === RECOVERY_MAXIMIZE_URL) {
      event.preventDefault();
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
      publishWindowState(mainWindow);
      return;
    }
    if (url === RECOVERY_CLOSE_URL) {
      event.preventDefault();
      void persistWindowState();
      mainWindow.hide();
      return;
    }
    if (url === RECOVERY_RETRY_URL) {
      event.preventDefault();
      void retryDesktopRecovery();
      return;
    }
    if (url === RECOVERY_EXIT_URL) {
      event.preventDefault();
      requestApplicationQuit();
      return;
    }
    if ((recoveryPageActive && url === recoveryPageUrl) || (backendOrigin && url.startsWith(`${backendOrigin}/`))) return;
    event.preventDefault();
    const external = safeExternalUrl(url);
    if (external) void shell.openExternal(external);
  });
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || quitting || !desktopStartupComplete) return;
    if (validatedURL && validatedURL === controlledNavigationUrl) return;
    if (recoveryPageActive && String(validatedURL || "").startsWith("data:text/html")) return;
    writeDiagnosticLog(`renderer did-fail-load: code=${errorCode} description=${errorDescription || "unknown"} url=${validatedURL || ""}`);
    void recoverRendererSurface(`桌面页面加载失败（${errorCode}：${errorDescription || "未知错误"}）。`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    if (quitting || !desktopStartupComplete) return;
    if (controlledNavigationUrl) return;
    const reason = String(details?.reason || "unknown");
    writeDiagnosticLog(`renderer process gone: reason=${reason} exitCode=${details?.exitCode ?? ""}`);
    void recoverRendererSurface(`桌面渲染进程中断（${reason}）。`);
  });
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (!installed) return;
    const reload = input.key === "F5" || ((input.control || input.meta) && input.key.toLowerCase() === "r");
    const devtools = input.key === "F12" || ((input.control || input.meta) && input.shift && input.key.toLowerCase() === "i");
    if (reload || devtools) event.preventDefault();
  });
  mainWindow._savedWindowState = saved;
  mainWindow.once("ready-to-show", showMainWindow);
  mainWindow.on("maximize", () => { publishWindowState(); scheduleWindowStateSave(); });
  mainWindow.on("unmaximize", () => { publishWindowState(); scheduleWindowStateSave(); });
  mainWindow.on("enter-full-screen", () => publishWindowState());
  mainWindow.on("leave-full-screen", () => publishWindowState());
  mainWindow.on("resize", scheduleWindowStateSave);
  mainWindow.on("move", scheduleWindowStateSave);
  mainWindow.on("unresponsive", () => {
    if (quitting || !desktopStartupComplete || rendererUnresponsive) return;
    rendererUnresponsive = true;
    writeDiagnosticLog(`renderer unresponsive; graceMs=${RENDERER_UNRESPONSIVE_GRACE_MS}`);
    mainWindow?.setTitle(`${PRODUCT_NAME_ZH} · 界面无响应，正在恢复`);
    mainWindow?.setProgressBar(2, { mode: "indeterminate" });
    clearTimeout(rendererUnresponsiveTimer);
    rendererUnresponsiveTimer = setTimeout(() => {
      if (!rendererUnresponsive || quitting || !mainWindow || mainWindow.isDestroyed()) return;
      writeDiagnosticLog("renderer unresponsive grace elapsed; forcing isolated renderer restart");
      console.error("[shensi-desktop-renderer-unresponsive] forcing isolated renderer restart");
      mainWindow.webContents.forcefullyCrashRenderer();
    }, RENDERER_UNRESPONSIVE_GRACE_MS);
    rendererUnresponsiveTimer.unref?.();
  });
  mainWindow.on("responsive", () => {
    if (rendererUnresponsive) writeDiagnosticLog("renderer responsive");
    rendererUnresponsive = false;
    clearTimeout(rendererUnresponsiveTimer);
    rendererUnresponsiveTimer = null;
    if (!recoveryPageActive && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(`${PRODUCT_NAME_ZH} ${app.getVersion()}`);
      mainWindow.setProgressBar(-1);
    }
  });
  mainWindow.on("close", (event) => {
    if (rendererApprovedClose || quitting || mainWindow?.isDestroyed()) return;
    event.preventDefault();
    void persistWindowState();
    mainWindow.hide();
  });
  mainWindow.on("closed", () => {
    clearTimeout(rendererCloseTimer);
    rendererCloseTimer = null;
    clearTimeout(rendererUnresponsiveTimer);
    rendererUnresponsiveTimer = null;
    mainWindow = null;
  });
  // Show a loading page immediately so the window is visible while the backend starts.
  // This prevents the app from appearing stuck in the system tray on first install or slow startup.
  try {
    await showRecoveryPage({ phase: "starting", reason: "正在启动神思本地核心…" });
  } catch {
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
};

const showStartupFailure = async (error) => {
  const detail = error instanceof Error ? error.message : String(error);
  // Ensure the window is visible so the user knows the app is running, even on failure.
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
  await dialog.showMessageBox({
    type: "error",
    title: PRODUCT_NAME_ZH,
    message: "神思桌面版未能启动",
    detail,
    buttons: ["确定"],
    noLink: true,
  });
};

app.on("second-instance", (_event, commandLine, workingDirectory) => {
  if (commandLine.includes("--shensi-quit")) {
    requestApplicationQuit();
    return;
  }
  queueExternalMarkdownArguments(commandLine, workingDirectory);
  showMainWindowFromBackground();
  if (commandLine.includes("--open-settings")) openSettingsFromBackground();
  void drainExternalMarkdownPaths();
});

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  queueExternalMarkdownArguments([filePath], process.cwd());
  void drainExternalMarkdownPaths();
});

app.on("activate", () => {
  showMainWindowFromBackground();
});

app.on("before-quit", (event) => {
  if (quitting) return;
  writeDiagnosticLog("desktop before-quit");
  event.preventDefault();
  quitting = true;
  desktopStartupComplete = false;
  clearTimeout(windowStateTimer);
  clearTimeout(rendererUnresponsiveTimer);
  clearTimeout(rendererCloseTimer);
  rendererCloseTimer = null;
  clearBackendStabilityTimer();
  void (async () => {
    await persistWindowState();
    await stopBackend();
    tray?.destroy();
    tray = null;
    app.exit(0);
  })();
});

// Closing the frameless window means "run in background". Only the tray Exit
// command (or the operating system shutdown lifecycle) ends the process.
app.on("window-all-closed", () => {});

const allowTrustedRendererPermission = (webContents, permission, requestingOrigin = "") => {
  if (permission !== "fullscreen"
    || !mainWindow
    || mainWindow.isDestroyed()
    || webContents !== mainWindow.webContents
    || !backendOrigin) return false;
  try {
    const rendererOrigin = new URL(String(requestingOrigin || webContents.getURL())).origin;
    return rendererOrigin === backendOrigin;
  } catch {
    return false;
  }
};

if (singleInstance) {
  writeDiagnosticLog(`app starting; installed=${installed}; packaged=${app.isPackaged}; appRoot=${appRoot}; serverEntryExists=${existsSync(serverEntry)}; machineLocalDataRoot=${machineLocalDataRoot}; businessDataRoot=${serverMachineDataRoot}`);

  void app.whenReady().then(async () => {
    writeDiagnosticLog("app.whenReady fired");
    installWindowBridge();
    createApplicationTray();
    installWindowsTaskbarActions();
    session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => (
      allowTrustedRendererPermission(webContents, permission, requestingOrigin)
    ));
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details = {}) => callback(
      allowTrustedRendererPermission(webContents, permission, details.requestingOrigin || details.requestingUrl || ""),
    ));
    try {
      await createMainWindowShell();
      await startInitialBackend();
      await loadApplicationPage();
      showMainWindow();
      desktopStartupComplete = true;
      await drainExternalMarkdownPaths();
    } catch (error) {
      console.error("[shensi-desktop-startup]", error);
      await showStartupFailure(error);
      await stopBackend();
      quitting = true;
      app.exit(1);
    }
  });
}

export { APP_USER_MODEL_ID, PRODUCT_NAME_EN, PRODUCT_NAME_ZH };
