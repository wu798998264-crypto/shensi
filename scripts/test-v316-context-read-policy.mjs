import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  contextDocumentMayBeRead,
  contextDocumentReadDecision,
  LIBRARY_MEMO_DOCUMENT_ID,
  selfCheckReportMayBeReadForMutation,
} from "../src/context-read-policy.js";
import { createBlankProjectState } from "../src/data.js";
import { buildExecutionContextReadState, executionContextLoopSummary, executionDocumentSummary, executionSkillSummary, readModeLabel } from "../src/execution-summary.js";
import { buildProjectQuestionContext } from "../src/general-project-context.js";
import { resolveContextRequest } from "../src/server/context-read-broker.mjs";
import { buildTaskContextManifest } from "../src/server/task-session-manager.mjs";

const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
assert.match(styles, /\.skill-import-processor-note\[open\] > summary::after\s*\{\s*content:\s*"\\2212"/u, "复合 Skill 说明展开图标必须使用编码安全的减号");
assert.doesNotMatch(styles, /content:\s*"âˆ’"/u, "样式中不得残留乱码减号");
assert.match(styles, /content:\s*" · 当前为只读预览，只能查找"/u, "只读查找提示必须使用正常中文");
assert.doesNotMatch(styles, /content:\s*"[^"]*(?:Â|Ã|â|ï¿½|锟|�)[^"]*"/u, "CSS 伪元素文案不得残留编码乱码");
assert.match(appSource, /data-context-readout/u, "写作卡必须展示上下文读取回执");
assert.match(appSource, /计划读取/u, "写作卡必须区分计划读取与实际读取");
assert.match(appSource, /实际加载 Skill/u, "写作卡必须显示实际加载的 Skill");
assert.match(serverSource, /generalTaskSkillRecords[\s\S]{0,4000}skills:\s*Object\.fromEntries/u, "通用 Chat 必须登记自动路由的计划 Skill");
assert.match(serverSource, /generalLoadedSkillRecords[\s\S]{0,5000}readEvents:/u, "通用 Chat 必须记录真正进入模型输入的 Skill");
assert.match(serverSource, /contextReads:\s*generalContextReadState\(\{\s*status:\s*"complete"/u, "通用 Chat 最终响应必须返回实际 Skill 读取回执");

const libraryDocument = { id: "library-reference", title: "参考资料", moduleId: "library", html: "<p>只供用户查看的备份材料</p>" };
assert.equal(contextDocumentMayBeRead({ documentId: libraryDocument.id, title: libraryDocument.title, moduleId: "library", document: libraryDocument }), false);
assert.equal(contextDocumentMayBeRead({ documentId: libraryDocument.id, title: libraryDocument.title, moduleId: "library", document: libraryDocument, explicitlyReferenced: true }), true);
assert.equal(contextDocumentReadDecision({ documentId: libraryDocument.id, title: libraryDocument.title, moduleId: "library", document: libraryDocument, instruction: "读取参考资料并与当前设定比较" }).mode, "explicit");

assert.equal(selfCheckReportMayBeReadForMutation({ documentId: "report-novel", instruction: "根据小说自检报告修改第三章正文", targetDomain: "novel" }), true);
assert.equal(selfCheckReportMayBeReadForMutation({ documentId: "report-novel", instruction: "写第三章正文", targetDomain: "novel" }), false);
assert.equal(selfCheckReportMayBeReadForMutation({ documentId: "report-script", instruction: "根据剧本自检报告修改第一集剧本", targetDomain: "script" }), true);
assert.equal(selfCheckReportMayBeReadForMutation({ documentId: "report-adaptation", instruction: "根据改编报告修改第一集剧本", targetDomain: "script-adaptation" }), true);
assert.equal(selfCheckReportMayBeReadForMutation({ documentId: "report-adaptation", instruction: "写第一集剧本", targetDomain: "script-adaptation" }), false);

const documents = {
  "outline-series": { title: "全集大纲", moduleId: "outline", html: "<p>主角完成第一阶段成长。</p>" },
  "library-reference": libraryDocument,
  "library-retired": { title: "废弃设定", moduleId: "library", html: "<p>旧世界规则</p>" },
  "report-novel": { title: "小说自检", moduleId: "reports", html: "<p>第三章节奏需要修复。</p>" },
};
const automaticWholeProject = buildProjectQuestionContext({
  projectName: "测试作品",
  documents,
  prompt: "完整读取当前作品并概括剧情",
});
assert.match(automaticWholeProject, /全集大纲/u);
assert.doesNotMatch(automaticWholeProject, /只供用户查看的备份材料|旧世界规则/u);

const explicitLibrary = buildProjectQuestionContext({
  projectName: "测试作品",
  documents,
  prompt: "完整读取当前作品，并读取参考资料",
  referenceIds: ["library-reference"],
});
assert.match(explicitLibrary, /只供用户查看的备份材料/u);

const automaticManifest = buildTaskContextManifest({
  documents,
  query: "写第三章正文",
  includedIds: ["outline-series"],
  targetDocumentId: "",
});
assert.equal(automaticManifest.some((item) => item.id === "library-reference"), false);
assert.equal(automaticManifest.some((item) => item.id === "report-novel"), false);

const reviewMutationManifest = buildTaskContextManifest({
  documents,
  query: "根据小说自检报告修改第三章正文",
  includedIds: ["outline-series", "report-novel"],
  targetDocumentId: "",
});
assert.equal(reviewMutationManifest.some((item) => item.id === "report-novel" && item.readMode !== "manifest"), true);

const adaptiveLibraryRequest = {
  sufficient: false,
  confidence: "medium",
  needs: [{ id: "need-reference", need: "补充背景资料", sourceKinds: ["reference"], query: "旧世界规则", blocking: false }],
};
const automaticAdaptiveRead = await resolveContextRequest({
  request: adaptiveLibraryRequest,
  documents: { "library-reference": libraryDocument },
  project: { documentIds: ["library-reference"] },
  target: { domain: "novel", instruction: "写第三章正文" },
});
assert.equal(automaticAdaptiveRead.manifest.included.length, 0, "资料补读代理也不能主动读取资料库");

const namedAdaptiveRead = await resolveContextRequest({
  request: adaptiveLibraryRequest,
  documents: { "library-reference": libraryDocument },
  project: { documentIds: ["library-reference"] },
  target: { domain: "novel", instruction: "读取参考资料并与当前设定比较" },
});
assert.equal(namedAdaptiveRead.manifest.included[0]?.name, "参考资料", "用户点名后补读代理可以读取资料库");
assert.equal(namedAdaptiveRead.manifest.included[0]?.fullText, true, "动态补读的所需资料必须完成全文读取");
assert.match(namedAdaptiveRead.prewriteContext, /shensi-execution-source/u, "动态补读全文必须带有实际读取来源凭证");

const blank = createBlankProjectState({ name: "新作品" });
assert.equal(blank.moduleItems.library.some(([id]) => id === LIBRARY_MEMO_DOCUMENT_ID), true);
assert.equal(blank.documents[LIBRARY_MEMO_DOCUMENT_ID]?.title, "备忘录");
assert.equal(blank.documents[LIBRARY_MEMO_DOCUMENT_ID]?.html, "");
assert.equal(blank.documents[LIBRARY_MEMO_DOCUMENT_ID]?.readPolicy, "explicit-only");

assert.equal(executionDocumentSummary({ contextDocuments: ["全集大纲", "第一卷卷纲", "人物设定", "状态快照", "上一章"] }), "全集大纲、第一卷卷纲、人物设定、状态快照 等");
assert.equal(executionSkillSummary({ plannedSkillNames: ["小说主笔", "连续性检查"] }), "计划：小说主笔、连续性检查");
assert.equal(executionSkillSummary({ runtimeSkills: [{ name: "小说主笔" }, { name: "连续性检查" }] }), "小说主笔、连续性检查");
assert.match(executionContextLoopSummary({ contextRounds: 1, requestedNeedCount: 1, fulfilledNeedCount: 1, includedSources: [{ id: "canon-characters", name: "人物设定" }] }), /使用 人物设定/u);

const readState = buildExecutionContextReadState({
  status: "complete",
  currentStage: "finished",
  plannedDocuments: [{ id: "outline-series", title: "全集大纲", readMode: "full" }],
  plannedSkills: [{ id: "writer", name: "小说主笔", version: "1.0" }],
  readEvents: [{
    stage: "creative",
    documents: [{ id: "outline-series", title: "全集大纲", readMode: "full", fullText: true, compressed: true, chunksRead: 4 }],
    skills: [{ id: "writer", name: "小说主笔", version: "1.0" }],
  }],
});
assert.equal(readState.locked, true);
assert.equal(readState.actual.documents[0].title, "全集大纲");
assert.equal(readState.actual.documents[0].compressed, true);
assert.deepEqual(readState.actual.skills[0].stages, ["creative"]);
assert.match(readModeLabel(readState.actual.documents[0]), /全文压缩读取/u);
assert.equal(readState.stages[0].documents[0].title, "全集大纲");

console.log("v3.1.6 资料库显式读取、备忘录、自检报告例外与执行名称摘要测试通过");
