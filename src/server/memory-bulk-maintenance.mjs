import { buildMemoryBackfillPlan } from "../memory-backfill.js";
import { memoryHealth } from "../memory-health.js";
import { isAbsolute, relative, resolve } from "node:path";
import { persistentWorksRoot } from "./app-data.mjs";
import { applyReviewedMemoryBackfillCandidate } from "./memory-review-service.mjs";
import { listWorkspaceProjects, loadWorkspaceState, saveWorkspaceState } from "./workspace.mjs";

const boundedBatchSize = (value) => Math.max(1, Math.min(50, Number(value) || 50));

export const backfillAllWorkspaceMemory = async ({
  appRoot,
  apply = false,
  confirmedByUser = false,
  batchSize = 50,
  reviewer = "user-authorized-maintenance",
  onProgress = () => {},
} = {}) => {
  if (!appRoot) throw new Error("批量记忆维护缺少应用根目录");
  if (apply && !confirmedByUser) throw new Error("批量记忆写入必须带明确用户确认");
  const writableRoot = resolve(persistentWorksRoot());
  const projects = (await listWorkspaceProjects({ appRoot })).filter(({ managed, workspacePath }) => {
    if (!managed) return false;
    const pathFromRoot = relative(writableRoot, resolve(workspacePath));
    return pathFromRoot !== "" && !pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot);
  });
  const summary = {
    schemaVersion: 1,
    mode: apply ? "apply" : "preview",
    startedAt: new Date().toISOString(),
    projectCount: projects.length,
    committed: 0,
    alreadyVerified: 0,
    blocked: 0,
    projects: [],
  };
  const maximumIterations = 10_000;
  let iterations = 0;
  for (const project of projects) {
    let loaded = await loadWorkspaceState({ appRoot, requestedPath: project.workspacePath });
    if (!loaded.state) continue;
    const before = memoryHealth({ moduleItems: loaded.state.moduleItems, documents: loaded.state.documents });
    const projectResult = {
      name: project.name,
      workspacePath: project.workspacePath,
      before: {
        plannedTotal: before.plannedTotal,
        total: before.total,
        unwritten: before.unwritten,
        covered: before.covered,
        verified: before.verified,
        stale: before.stale,
        missing: before.missing,
      },
      committed: 0,
      blocked: 0,
    };
    summary.alreadyVerified += before.verified;
    if (!apply) {
      const preview = buildMemoryBackfillPlan({
        moduleItems: loaded.state.moduleItems,
        documents: loaded.state.documents,
        limit: 1_000,
      });
      projectResult.proposed = preview.proposed;
      projectResult.blocked = preview.blocked;
      projectResult.remaining = before.backfillQueue.length;
      summary.blocked += preview.blocked;
      summary.projects.push(projectResult);
      continue;
    }
    while (iterations < maximumIterations) {
      iterations += 1;
      loaded = await loadWorkspaceState({ appRoot, requestedPath: project.workspacePath });
      const plan = buildMemoryBackfillPlan({
        moduleItems: loaded.state.moduleItems,
        documents: loaded.state.documents,
        limit: 1_000,
      });
      const proposals = plan.candidates.filter(({ status }) => status === "proposal");
      projectResult.blocked = plan.candidates.filter(({ status }) => status === "blocked").length;
      if (!proposals.length) break;
      let passCommitted = 0;
      const size = boundedBatchSize(batchSize);
      for (let offset = 0; offset < proposals.length; offset += size) {
        loaded = await loadWorkspaceState({ appRoot, requestedPath: project.workspacePath });
        const selected = proposals.slice(offset, offset + size);
        const changedDocuments = {};
        const reviewedAt = new Date().toISOString();
        for (const candidate of selected) {
          const prepared = applyReviewedMemoryBackfillCandidate({
            candidate,
            documentState: loaded.state.documents?.[candidate.documentId],
            review: { decision: "approve", reviewer },
            reviewedAt,
          });
          if (prepared.changed) changedDocuments[candidate.documentId] = prepared.documentState;
        }
        const documentIds = Object.keys(changedDocuments);
        if (!documentIds.length) continue;
        const { savedAt: _loadedSavedAt, ...loadedState } = loaded.state;
        await saveWorkspaceState({
          appRoot,
          requestedPath: project.workspacePath,
          expectedStateStamp: loaded.stateStamp,
          state: {
            ...loadedState,
            documents: changedDocuments,
            documentPatch: { mode: "delta-v1", documentIds: Object.keys(loaded.state.documents ?? {}) },
          },
        });
        passCommitted += documentIds.length;
        projectResult.committed += documentIds.length;
        summary.committed += documentIds.length;
        await onProgress({ project: project.name, committed: projectResult.committed, batch: documentIds.length });
      }
      if (!passCommitted) break;
    }
    if (iterations >= maximumIterations) throw new Error("批量记忆维护超过安全迭代上限");
    loaded = await loadWorkspaceState({ appRoot, requestedPath: project.workspacePath });
    const after = memoryHealth({ moduleItems: loaded.state.moduleItems, documents: loaded.state.documents });
    projectResult.after = {
      plannedTotal: after.plannedTotal,
      total: after.total,
      unwritten: after.unwritten,
      covered: after.covered,
      verified: after.verified,
      stale: after.stale,
      missing: after.missing,
    };
    projectResult.remaining = after.backfillQueue.length;
    summary.blocked += projectResult.blocked;
    summary.projects.push(projectResult);
  }
  summary.completedAt = new Date().toISOString();
  return summary;
};
