import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runShensiOrchestration } from "../src/server/shensi-orchestrator.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const planning = JSON.stringify({
  action: "generate",
  taskType: "write_chapter",
  target: "第一章正文",
  intent: "完成雨夜开篇",
  question: "",
  capsule: "林舟在雨夜回到旧站台",
  evidencePlan: [],
  productionPlan: ["完成开篇"],
  hardConstraints: [],
  desiredEffects: ["克制悬念"],
  chapterMission: "开篇",
  narrativeMode: "外部行动",
  endingFunction: "方向转换",
  protectedAssets: [],
  recentReuseRisks: [],
  canonRisks: [],
  decisionGap: { key: "", impact: "ordinary", inferable: true, alreadyAnswered: true, evidence: "" },
  plotAssessment: null,
  conceptBindings: [],
  narrativeLock: null,
  guidanceState: null,
  routeAdaptation: { decision: "stay", confidence: "high", reason: "直接写", evidence: ["用户指令"] },
  contextAssessment: { sufficient: true, confidence: "high", needs: [] },
});

const stages = [];
const revised = await runShensiOrchestration({
  shensiRoot: root,
  settings: {},
  messages: [{ role: "user", content: "直接写第一章并落盘，不要自检。" }],
  projectContext: "作品：测试。当前正文为空。",
  postwriteProjectContext: "没有额外正史冲突。",
  activeModule: "manuscript",
  contextDomain: "novel",
  workspaceKind: "project",
  targetDocumentId: "chapter-1",
  semanticLane: "task_execution",
  semanticWriteIntent: "commit",
  semanticDeliverableType: "novel",
  semanticExecutionPlan: { reviewTier: "none", candidateCount: 1 },
  cwd: root,
  languagePolicy: { absoluteTerms: ["仿佛"], creativeContractText: "项目禁用词：仿佛" },
  runModel: async ({ shensiRuntime }) => {
    stages.push(shensiRuntime?.stage || "unknown");
    if (shensiRuntime?.stage === "planning") return { text: planning };
    if (shensiRuntime?.stage === "creative") return { text: "【候选稿】\n雨幕仿佛一堵墙。林舟仿佛没有听见钟声。" };
    if (shensiRuntime?.stage === "revision") return { text: JSON.stringify({ replacements: [
      { before: "雨幕仿佛一堵墙。", after: "雨幕压成一堵灰墙。" },
      { before: "林舟仿佛没有听见钟声。", after: "林舟没有理会钟声。" },
    ] }) };
    throw new Error(`unexpected stage: ${shensiRuntime?.stage}`);
  },
});
assert.deepEqual(stages, ["planning", "creative", "revision"]);
assert.match(revised.text, /雨幕压成一堵灰墙/u);
assert.doesNotMatch(revised.text, /仿佛/u);
assert.equal(revised.writingStyleQuality.blocking, false);
assert.equal(revised.writingStyleQuality.mayLand, true);
assert.equal(revised.writingStyleQuality.candidates[0].revisionAttempts, 1);
assert.equal(revised.execution.status, "ready_to_land");

const failedStages = [];
const degraded = await runShensiOrchestration({
  shensiRoot: root,
  settings: {},
  messages: [{ role: "user", content: "直接写第一章正文并落盘，不要自检。" }],
  projectContext: "作品：测试。",
  postwriteProjectContext: "没有额外正史冲突。",
  activeModule: "manuscript",
  contextDomain: "novel",
  workspaceKind: "project",
  targetDocumentId: "chapter-1",
  semanticLane: "task_execution",
  semanticWriteIntent: "commit",
  semanticDeliverableType: "novel",
  semanticExecutionPlan: { reviewTier: "none", candidateCount: 1 },
  cwd: root,
  languagePolicy: { absoluteTerms: ["仿佛"], currentDocumentText: "前文已经出现仿佛。" },
  runModel: async ({ shensiRuntime }) => {
    failedStages.push(shensiRuntime?.stage || "unknown");
    if (shensiRuntime?.stage === "planning") return { text: planning };
    if (shensiRuntime?.stage === "creative") return { text: "【候选稿】\n他仿佛听见门外有脚步。林舟把信纸压在桌角，雨水正沿着窗框往下淌。" };
    if (shensiRuntime?.stage === "revision") throw new Error("revision service unavailable");
    throw new Error(`unexpected stage: ${shensiRuntime?.stage}`);
  },
});
assert.deepEqual(failedStages, ["planning", "creative", "revision"]);
assert.match(degraded.text, /他仿佛听见门外有脚步/u, "修订失败必须继续返回初稿");
assert.equal(degraded.execution.status, "ready_to_land", "修订失败不得阻断落盘");
assert.equal(degraded.writingStyleQuality.candidates[0].status, "revision_failed");
assert.match(degraded.writingStyleQuality.notices[0], /已保留初稿并继续/u);

console.log("writing style orchestration soft-quality integration tests passed");
