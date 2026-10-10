const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("shensiDesktop", { generationDrafts: { write: payload => ipcRenderer.sendSync("shensi:generation-draft:write", payload) } });
