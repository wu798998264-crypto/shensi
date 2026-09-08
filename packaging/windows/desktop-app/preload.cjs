const { contextBridge, ipcRenderer } = require("electron");

const versionArgument = process.argv.find((argument) => argument.startsWith("--shensi-app-version="));
const appVersion = versionArgument ? versionArgument.slice("--shensi-app-version=".length) : "1.0.0";

contextBridge.exposeInMainWorld("shensiDesktop", Object.freeze({
  runtime: "electron",
  platform: process.platform,
  appVersion,
  externalMarkdown: Object.freeze({
    ready: () => ipcRenderer.invoke("shensi:external-markdown:renderer-ready"),
    onOpened: (listener) => {
      if (typeof listener !== "function") return () => {};
      const handler = (_event, payload) => listener(payload || {});
      ipcRenderer.on("shensi:external-markdown-opened", handler);
      return () => ipcRenderer.removeListener("shensi:external-markdown-opened", handler);
    },
  }),
  credentials: Object.freeze({
    readGeneration: () => ipcRenderer.invoke("shensi:credentials:read-generation"),
    writeGeneration: (secrets) => ipcRenderer.invoke("shensi:credentials:write-generation", { secrets }),
    nutstoreStatus: () => ipcRenderer.invoke("shensi:credentials:nutstore-status"),
    storeNutstore: (payload) => ipcRenderer.invoke("shensi:credentials:nutstore-store", {
      account: String(payload?.account || ""),
      password: String(payload?.password || ""),
    }),
    clearNutstore: () => ipcRenderer.invoke("shensi:credentials:nutstore-clear"),
  }),
  path: Object.freeze({
    reveal: (payload) => ipcRenderer.invoke("shensi:path:reveal", {
      targetPath: String(payload?.targetPath || ""),
      selectFile: payload?.selectFile === true,
    }),
    open: (payload) => ipcRenderer.invoke("shensi:path:open", {
      targetPath: String(payload?.targetPath || ""),
    }),
    selectDirectory: (payload) => ipcRenderer.invoke("shensi:path:select-directory", {
      kind: payload?.kind === "notebook" ? "notebook" : payload?.kind === "agent" ? "agent" : "project",
      defaultPath: String(payload?.defaultPath || ""),
    }),
  }),
  file: Object.freeze({
    saveBinary: (payload) => ipcRenderer.invoke("shensi:file:save-binary", {
      bytes: payload?.bytes instanceof Uint8Array ? payload.bytes : new Uint8Array(payload?.bytes || []),
      suggestedName: String(payload?.suggestedName || ""),
      mimeType: String(payload?.mimeType || "application/octet-stream"),
    }),
    saveText: (payload) => ipcRenderer.invoke("shensi:file:save-text", {
      content: String(payload?.content || ""),
      suggestedName: String(payload?.suggestedName || ""),
      mimeType: String(payload?.mimeType || "text/plain"),
    }),
    saveWorkspaceMedia: (payload) => ipcRenderer.invoke("shensi:file:save-workspace-media", {
      workspacePath: String(payload?.workspacePath || ""),
      relativePath: String(payload?.relativePath || ""),
      suggestedName: String(payload?.suggestedName || ""),
      kind: String(payload?.kind || ""),
      mimeType: String(payload?.mimeType || ""),
    }),
  }),
  clipboard: Object.freeze({
    writeText: (text) => ipcRenderer.invoke("shensi:clipboard:write-text", { text: String(text ?? "") }),
    readText: () => ipcRenderer.invoke("shensi:clipboard:read-text"),
    writeWorkspaceImage: (payload) => ipcRenderer.invoke("shensi:clipboard:write-workspace-image", {
      workspacePath: String(payload?.workspacePath || ""),
      relativePath: String(payload?.relativePath || ""),
    }),
    writeWorkspaceFile: (payload) => ipcRenderer.invoke("shensi:clipboard:write-workspace-file", {
      workspacePath: String(payload?.workspacePath || ""),
      relativePath: String(payload?.relativePath || ""),
    }),
    writeWhiteboardCardFiles: (payload) => ipcRenderer.invoke("shensi:clipboard:write-whiteboard-card-files", {
      workspacePath: String(payload?.workspacePath || ""),
      cards: (Array.isArray(payload?.cards) ? payload.cards : []).slice(0, 100).map((card) => ({
        kind: String(card?.kind || "text"),
        name: String(card?.name || ""),
        relativePath: String(card?.relativePath || ""),
        text: String(card?.text || ""),
      })),
    }),
    readFiles: () => ipcRenderer.invoke("shensi:clipboard:read-files"),
    readImage: () => ipcRenderer.invoke("shensi:clipboard:read-image"),
  }),
  windowControl: Object.freeze({
    minimize: () => ipcRenderer.invoke("shensi:window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("shensi:window:toggle-maximize"),
    isMaximized: () => ipcRenderer.invoke("shensi:window:is-maximized"),
    setFullscreen: (active) => ipcRenderer.invoke("shensi:window:set-fullscreen", active === true),
    isFullscreen: () => ipcRenderer.invoke("shensi:window:is-fullscreen"),
    getState: () => ipcRenderer.invoke("shensi:window:get-state"),
    close: () => ipcRenderer.invoke("shensi:window:close"),
    requestApplicationQuit: () => ipcRenderer.invoke("shensi:application:quit"),
    confirmClose: (saved) => ipcRenderer.invoke("shensi:window:confirm-close", saved === true),
    onCloseRequested: (listener) => {
      if (typeof listener !== "function") return () => {};
      const handler = () => listener();
      ipcRenderer.on("shensi:prepare-close", handler);
      return () => ipcRenderer.removeListener("shensi:prepare-close", handler);
    },
    onSettingsRequested: (listener) => {
      if (typeof listener !== "function") return () => {};
      const handler = () => listener();
      ipcRenderer.on("shensi:open-settings", handler);
      return () => ipcRenderer.removeListener("shensi:open-settings", handler);
    },
    onMaximizedChanged: (listener) => {
      if (typeof listener !== "function") return () => {};
      const handler = (_event, state) => listener(state?.maximized === true || state?.fullscreen === true);
      ipcRenderer.on("shensi:window-state", handler);
      return () => ipcRenderer.removeListener("shensi:window-state", handler);
    },
    onFullscreenChanged: (listener) => {
      if (typeof listener !== "function") return () => {};
      const handler = (_event, state) => listener(state?.fullscreen === true);
      ipcRenderer.on("shensi:window-state", handler);
      return () => ipcRenderer.removeListener("shensi:window-state", handler);
    },
  }),
}));
