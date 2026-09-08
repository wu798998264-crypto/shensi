import { stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export const resolveDirectoryDialogDefaultPath = async (requestedPath, { statImpl = stat } = {}) => {
  const source = String(requestedPath || "").trim();
  if (!source || !isAbsolute(source)) return "";
  const targetPath = resolve(source);
  const info = await statImpl(targetPath).catch(() => null);
  if (info?.isDirectory()) return targetPath;
  if (info?.isFile()) return dirname(targetPath);
  return "";
};

export const directoryDialogOptions = ({ kind = "project", defaultPath = "" } = {}) => {
  const workspaceKind = kind === "notebook" ? "notebook" : kind === "agent" ? "agent" : "project";
  return {
    title: workspaceKind === "agent" ? "选择 Codex Agent 项目目录" : workspaceKind === "notebook" ? "选择要导入的笔记目录" : "选择要导入的作品目录",
    buttonLabel: workspaceKind === "agent" ? "选择此项目" : workspaceKind === "notebook" ? "导入笔记目录" : "导入作品目录",
    properties: ["openDirectory", "dontAddToRecent"],
    ...(defaultPath ? { defaultPath: resolve(defaultPath) } : {}),
  };
};
