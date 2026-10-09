// A child launched by an MSIX host can inherit that host's shell identity.
// Bind the main HWND explicitly so it matches Shensi's installed shortcuts.
// Do not change the host process, pinning preferences, icon or window geometry.
export const applyMainWindowTaskbarIdentity = (window, {
  appId,
  platform = process.platform,
} = {}) => {
  if (platform !== "win32" || !window || window.isDestroyed()) return false;
  if (!String(appId || "").trim()) throw new Error("Windows 主窗口缺少应用标识");
  window.setAppDetails({ appId });
  return true;
};
