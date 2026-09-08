const cleanTargets = (targets = []) => targets.filter((target) => target && (target.scopeType || target.moduleId || target.documentId));

const WORKSPACE_WIDE_HISTORY_INTENT = /(?:整个|整部|全部|全量|全局|整体)(?:作品|项目|笔记本|笔记空间|笔记板块|工作区|创作空间)|(?:作品|项目|笔记本|笔记空间|笔记板块|工作区|创作空间)(?:整体|全量|全部)(?:优化|修改|整理|重构|更新|恢复)/u;

export const workspaceWideHistoryIntent = (instruction = "") => WORKSPACE_WIDE_HISTORY_INTENT.test(String(instruction || ""));

export const resolveHistoryTaskScope = (targets = []) => {
  const items = cleanTargets(targets);
  if (!items.length) return null;
  if (items.some((target) => target.scopeType === "project")) return { type: "project", id: "project" };

  const modules = new Set(items.map((target) => target.moduleId).filter(Boolean));
  if (modules.size > 1) return { type: "project", id: "project" };
  const moduleId = [...modules][0];
  if (!moduleId) return null;
  if (items.some((target) => target.scopeType === "module")) return { type: "module", id: moduleId };

  const views = new Set(items.map((target) => target.viewId).filter(Boolean));
  if (views.size > 1) return { type: "module", id: moduleId };
  const viewId = [...views][0];
  if (items.some((target) => target.scopeType === "view") || items.some((target) => target.coversView)) {
    return viewId ? { type: "view", id: `${moduleId}:${viewId}`, moduleId, viewId } : { type: "module", id: moduleId };
  }

  const documents = new Set(items.map((target) => target.documentId).filter(Boolean));
  const structural = items.some((target) => target.structural || ["volume", "view", "module"].includes(target.scopeType));
  if (documents.size === 1 && !structural) return { type: "document", id: [...documents][0] };

  const volumes = new Set(items.map((target) => target.volumeId).filter(Boolean));
  const allNovelVolumeTargets = moduleId === "manuscript"
    && viewId === "novel"
    && volumes.size === 1
    && items.every((target) => target.volumeId === [...volumes][0]);
  if (items.some((target) => target.scopeType === "volume") || allNovelVolumeTargets) {
    return { type: "volume", id: [...volumes][0] };
  }
  if (viewId) return { type: "view", id: `${moduleId}:${viewId}`, moduleId, viewId };
  return { type: "module", id: moduleId };
};
