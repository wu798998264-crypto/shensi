import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveCrossFormatContentRoute } from "../src/cross-format-content-router.js";
import { analyzeBatchLanding, analyzeSmartLandingPath } from "../src/automatic-landing-policy.js";
import { applyAnchoredTextEdit, createAnchoredTextEditContract } from "../src/anchored-text-edit.js";
import { createDocumentEditHistory, recordDocumentEditMutation, stepDocumentEditHistory } from "../src/document-edit-history.js";
import { getDynamicAttachmentLimit, validateConversationAttachments } from "../src/conversation-attachment-intake.js";
import {
  ackConversationInstruction,
  createConversationDispatchGate,
  dequeueReadyConversationInstruction,
  recoverConversationTaskQueue,
} from "../src/conversation-task-queue.js";
import { runModelAdapter } from "../src/server/adapters.mjs";
import { planSmartLanding } from "../src/server/smart-landing-planner.mjs";
import { createBlankProjectState } from "../src/data.js";
import { loadWorkspaceCurrentContent, loadWorkspaceState, saveWorkspaceState } from "../src/server/workspace.mjs";
import { compactRecoveryState, restoreRecoveryState } from "../src/recovery-checkpoint.js";
import { generationResultMayDefaultLand } from "../src/generation-attempt-client.js";

assert.equal(generationResultMayDefaultLand({
  candidate: "正式正文",
  generationAttempt: { validationStatus: "pending", landingStatus: "not_requested" },
  engineExecution: { validationStatus: "passed", landingStatus: "ready" },
}), true);
assert.equal(generationResultMayDefaultLand({
  candidate: "正式正文",
  target: { landingBlocked: true },
  engineExecution: { validationStatus: "passed", landingStatus: "ready" },
}), false);

// A stale recovery checkpoint must not hide a newer managed file that an
// Agent/CLI has already written to disk. Drafts based on the same fresh hash
// still restore normally.
const canonicalExternal = {
  documents: {
    contract: {
      markdown: "磁盘最新版",
      externalContentChanged: true,
      contentRef: { path: "09_索引/创作合同.md", hash: "new-disk-hash" },
    },
  },
};
const staleRecovery = restoreRecoveryState({
  canonicalState: canonicalExternal,
  checkpoint: {
    stateMode: "document-overlay-v2",
    documentIds: ["contract"],
    state: { documents: { contract: { markdown: "旧恢复草稿", contentRef: { hash: "old-hash" } } } },
  },
});
assert.equal(staleRecovery.documents.contract.markdown, "磁盘最新版");
const freshRecovery = restoreRecoveryState({
  canonicalState: canonicalExternal,
  checkpoint: {
    stateMode: "document-overlay-v2",
    documentIds: ["contract"],
    state: { documents: { contract: { markdown: "基于最新版的未保存草稿", contentRef: { hash: "new-disk-hash" } } } },
  },
});
assert.equal(freshRecovery.documents.contract.markdown, "基于最新版的未保存草稿");
const compactOverlay = compactRecoveryState({
  documents: { contract: { markdown: "草稿" } },
  viewHistories: { huge: "derived" },
  volumeHistories: { huge: "derived" },
  moduleHistories: { canonical: true },
});
assert.equal(compactOverlay.stateMode, "overlay-v1");
assert.ok(compactOverlay.omittedStateKeys.includes("viewHistories"));
assert.ok(compactOverlay.omittedStateKeys.includes("volumeHistories"));
assert.equal(Object.hasOwn(compactOverlay.state, "viewHistories"), false);

const documents = [
  { id: "empty", title: "临时空文档", contextDomain: "novel", projectName: "幻烬", html: "" },
  { id: "novel-1", title: "《幻烬》第一章小说", contextDomain: "novel", projectName: "幻烬", html: "<p>女主撑着红伞第一次出现在雨巷。</p>" },
  { id: "novel-2", title: "《幻烬》第二章小说", contextDomain: "novel", projectName: "幻烬", html: "<p>第二章正文。</p>" },
  { id: "script-1", title: "《幻烬》第一集剧本", contextDomain: "script", projectName: "幻烬", html: "<p>第二场：旧对白。</p>" },
  { id: "prompt-novel-1", title: "《幻烬》第一章提示词", projectName: "幻烬", html: "" },
  { id: "prompt-script-1", title: "《幻烬》第一集提示词", projectName: "幻烬", html: "" },
];

const route = (instruction, associatedDocumentId = "", list = documents, extra = {}) => resolveCrossFormatContentRoute({
  instruction,
  documents: list,
  associatedDocumentId,
  projectName: "幻烬",
  ...extra,
});

// 原始验收 35.5：八个中文场景必须使用真实中文输入，Source/Target 不得混淆。
const case1 = route("将《幻烬》第一章小说改编为剧本。", "empty", documents.filter((item) => item.id !== "script-1"));
assert.equal(case1.sourceDocumentId, "novel-1");
assert.equal(case1.targetContentType, "script");
assert.equal(case1.targetDocumentId, "");
assert.equal(case1.create.viewId, "script");
assert.notEqual(case1.sourceDocumentId, "empty");

const case2 = route("将其改编为剧本。", "novel-1");
assert.equal(case2.sourceDocumentId, "novel-1");
assert.equal(case2.targetDocumentId, "script-1");

const explicitNamedCrossFormat = route("把当前源小说改编成短剧，正式正文必须直接新建文档“第一集剧本验收”，不得覆盖当前文档。", "novel-1");
assert.equal(explicitNamedCrossFormat.targetDocumentId, "");
assert.equal(explicitNamedCrossFormat.create.title, "第一集剧本验收");
assert.equal(explicitNamedCrossFormat.sourceDocumentId, "novel-1");

const explicitNamedCrossFormatPlain = route("把当前源小说改编成短剧，正式正文必须直接新建文档第一集剧本验收，不得覆盖当前文档。", "novel-1");
assert.equal(explicitNamedCrossFormatPlain.create.title, "第一集剧本验收");
assert.equal(explicitNamedCrossFormatPlain.sourceDocumentId, "novel-1");

const case3 = route("根据这一章生成 Seedance 视频提示词。", "novel-1");
assert.equal(case3.sourceDocumentId, "novel-1");
assert.equal(case3.targetContentType, "prompt");
assert.equal(case3.targetDocumentId, "prompt-novel-1");

const case4 = route("根据当前剧本生成分镜视频提示词。", "script-1");
assert.equal(case4.sourceDocumentId, "script-1");
assert.equal(case4.targetDocumentId, "prompt-script-1");

const case5 = route("把它改写为小说第一章的新版本。", "script-1");
assert.equal(case5.sourceDocumentId, "script-1");
assert.equal(case5.targetDocumentId, "novel-1");
assert.equal(case5.operationType, "patch");

const case6 = route("根据现在的剧本重新生成提示词。", "script-1");
assert.equal(case6.sourceDocumentId, "script-1");
assert.equal(case6.targetDocumentId, "prompt-script-1");

const case7 = route("参考原小说女主第一次出现的段落，把这一场重新写得更贴近原著。", "script-1");
assert.equal(case7.sourceDocumentId, "novel-1");
assert.equal(case7.targetDocumentId, "script-1");
assert.equal(case7.operationType, "patch");
assert.equal(case7.referenceAssistedPatch, true);

assert.equal(route("帮我润色当前剧本第二场对白。", "script-1"), null);

const mapped = route("将其改编为剧本。", "novel-1", documents, {
  chapterEpisodeMappings: [{ sourceDocumentId: "novel-1", targetContentType: "script", targetDocumentId: "script-1" }],
});
assert.equal(mapped.mappingSource, "workspace_metadata");

// 用户明确要求新文档时，关联文档不能抢占 Target；批量成果必须独立落盘。
const explicitNew = analyzeSmartLandingPath({
  instruction: "落盘到一个新文档里，命名为第一章2",
  result: { candidate: "雨夜里，她终于推开那扇门。" },
  boundDocumentId: "novel-1",
  documents: Object.fromEntries(documents.map((item) => [item.id, { ...item, content: item.html }])),
});
assert.equal(explicitNew.action, "create_and_land");
assert.equal(explicitNew.suggestedTitle, "第一章2");

const batch = analyzeBatchLanding({
  boundDocumentId: null,
  documents: {},
  items: [
    { instruction: "新建人物设定，命名为林舟", content: "林舟：调查员。" },
    { instruction: "新建人物设定，命名为苏晚", content: "苏晚：记者。" },
  ],
});
assert.equal(batch.length, 2);
assert.ok(batch.every((item) => item.landingDecision.action === "create_and_land"));

// Patch 必须在用户已手改的最新版上定位，不能用旧候选覆盖全文。
const original = "第一场\n开场。\n第二场\n旧对白。\n第三场\n结尾。";
const startOffset = original.indexOf("旧对白。");
const contract = createAnchoredTextEditContract({
  documentId: "script-1",
  documentText: original,
  startOffset,
  endOffset: startOffset + "旧对白。".length,
});
const userLatest = `用户手动增加的开场细节。\n${original}`;
const patched = applyAnchoredTextEdit({ contract, currentText: userLatest, replacementText: "压缩后的对白。" });
assert.equal(patched.status, "applied");
assert.ok(patched.afterText.startsWith("用户手动增加的开场细节。"));
assert.ok(patched.afterText.includes("压缩后的对白。"));
assert.ok(!patched.afterText.includes("旧对白。"));

// A→B→恢复A 后，B 仍可 redo，证明恢复不是单向覆盖。
let history = createDocumentEditHistory("A");
history = recordDocumentEditMutation(history, { beforeHtml: "A", afterHtml: "B", inputType: "aiPatch", at: 1, forceBoundary: true });
const restoredA = stepDocumentEditHistory(history, "undo", { currentHtml: "B" });
assert.equal(restoredA.snapshot.html, "A");
const restoredB = stepDocumentEditHistory(restoredA.history, "redo", { currentHtml: "A" });
assert.equal(restoredB.snapshot.html, "B");

// 同一模型能力配置同时控制 UI intake 与发送前验证，不存在固定 6 个上限。
const capabilities = {
  provider: "自定义兼容接口",
  model: "large-context-test",
  maxMediaReferences: 24,
  maxImageReferences: 12,
  maxFileReferences: 24,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalUploadBytes: 32 * 1024 * 1024,
};
assert.equal(getDynamicAttachmentLimit(capabilities), 24);
const attachments = Array.from({ length: 18 }, (_, index) => ({
  name: `${index}.txt`, mimeType: "text/plain", size: 16,
}));
assert.equal(validateConversationAttachments(attachments, capabilities).valid, true);
assert.equal(validateConversationAttachments([...attachments, ...attachments], capabilities).code, "MAX_ATTACHMENTS");

// 原位编辑中的队列项不阻塞后续任务，lease/ack 保证旧任务不会重复执行。
const conversation = {
  queue: [
    { id: "editing", state: "editing", content: "正在修改" },
    { id: "next", state: "queued", content: "后续任务" },
  ],
};
recoverConversationTaskQueue(conversation);
const next = dequeueReadyConversationInstruction({ conversation, leaseId: "lease-next", now: 100 });
assert.equal(next.id, "next");
assert.equal(ackConversationInstruction({ conversation, itemId: "next", leaseId: "lease-next" }), true);
assert.equal(ackConversationInstruction({ conversation, itemId: "next", leaseId: "lease-next" }), true);
assert.equal(conversation.queue.filter((item) => item.id === "next").length, 0);
const gate = createConversationDispatchGate();
assert.equal(gate.claim("conversation-1", "task-1"), true);
assert.equal(gate.claim("conversation-1", "task-2"), false);
assert.equal(gate.release("conversation-1", "task-1"), true);

// 通用 CLI Adapter 通过真实子进程、stdin/stdout 完成调用，不修改任何用户 Provider 配置。
const cliResult = await runModelAdapter({
  settings: {
    adapter: "cli",
    provider: "通用 CLI 验收",
    model: "local-process",
    cliPath: process.execPath,
    cliArgs: "-e \"process.stdin.resume();let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log('CLI_E2E_OK:'+s.includes('正式正文')))\"",
    timeoutMs: 10_000,
  },
  messages: [{ role: "user", content: "生成正式正文" }],
  system: "只完成验收。",
  cwd: process.cwd(),
});
assert.equal(cliResult.protocol, "cli");
assert.match(cliResult.text, /CLI_E2E_OK:true/u);

// 智能落盘规划器必须只分配正式内容，不能把说明块误当作上一轮正文。
const landing = await planSmartLanding({
  settings: {},
  sourcePrompt: "把新生成的正文写入新文档《第一章2》",
  answer: "已经为你完成。\n\n---\n\n第一章2\n雨落在长街上。",
  inventory: [{ id: "novel-1", title: "第一章", moduleId: "manuscript", viewId: "novel" }],
  contextDomain: "novel",
  cwd: process.cwd(),
  runModel: async () => ({
    text: JSON.stringify({ summary: "说明块不落盘", documents: [{ targetHint: "第一章2正文", title: "第一章2", blocks: [2] }] }),
    protocol: "test",
  }),
});
assert.deepEqual(landing.plan.documents[0].blocks, [2]);

// 在隔离工作区落盘、重新加载并读取当前最新版，验证不是只在内存里成功。
const tempRoot = await mkdtemp(join(tmpdir(), "shensi-v113-e2e-"));
try {
  const appRoot = join(tempRoot, "app");
  const workspacePath = join(appRoot, "runtime", "幻烬验收");
  const state = createBlankProjectState("幻烬验收");
  state.documents["novel-1"] = { title: "《幻烬》第一章小说", html: "<p>原始小说正文。</p>", moduleId: "manuscript" };
  state.documents["script-1"] = { title: "《幻烬》第一集剧本", html: "<p>AI 初稿。</p>", moduleId: "manuscript", contextDomain: "script" };
  state.histories["script-1"] = [{ id: "v1", html: "<p>AI 初稿。</p>", source: "ai_generate" }];
  state.moduleItems.manuscript.push(["novel-1", "《幻烬》第一章小说", { workspaceView: "novel" }]);
  state.moduleItems.manuscript.push(["script-1", "《幻烬》第一集剧本", { workspaceView: "script", contextDomain: "script" }]);
  await saveWorkspaceState({ appRoot, requestedPath: workspacePath, state });
  const compactState = JSON.parse(await readFile(join(workspacePath, ".shensi", "current-state.json"), "utf8"));
  const missingTarget = join(workspacePath, ...compactState.documents["novel-1"].contentRef.path.split("/"));
  await unlink(missingTarget);
  const recoveredMissing = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
  assert.equal(recoveredMissing.state.documents["novel-1"].externalContentMissing, undefined);
  assert.equal((await stat(missingTarget)).isFile(), true);
  assert.match(recoveredMissing.state.documents["novel-1"].html, /原始小说正文/u);
  const loaded = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
  loaded.state.documents["script-1"].html = "<p>用户手动修改后的最新版剧本。</p>";
  loaded.state.documents["script-1"].markdown = "用户手动修改后的最新版剧本。";
  await saveWorkspaceState({
    appRoot,
    requestedPath: workspacePath,
    state: loaded.state,
    expectedStateStamp: loaded.stateStamp,
  });
  const latest = await loadWorkspaceCurrentContent({ appRoot, requestedPath: workspacePath });
  assert.match(latest.documents["script-1"].html, /用户手动修改后的最新版剧本/u);
  assert.doesNotMatch(latest.documents["script-1"].html, /AI 初稿/u);
  // A legitimate CLI/Agent edit of a managed Markdown file becomes the next
  // exact save baseline. It must not trap later auto-saves in a conflict loop.
  const refreshedCompactState = JSON.parse(await readFile(join(workspacePath, ".shensi", "current-state.json"), "utf8"));
  const scriptTarget = join(workspacePath, ...refreshedCompactState.documents["script-1"].contentRef.path.split("/"));
  const scriptSerialized = await readFile(scriptTarget, "utf8");
  await writeFile(scriptTarget, `${scriptSerialized.trim()}\n\nEXTERNAL_CLI_UPDATE\n`, "utf8");
  const externallyUpdated = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
  assert.equal(externallyUpdated.state.documents["script-1"].externalContentChanged, true);
  assert.match(externallyUpdated.state.documents["script-1"].html, /EXTERNAL_CLI_UPDATE/u);
  await saveWorkspaceState({
    appRoot,
    requestedPath: workspacePath,
    state: externallyUpdated.state,
    expectedStateStamp: externallyUpdated.stateStamp,
  });
  const mergedExternal = await loadWorkspaceCurrentContent({ appRoot, requestedPath: workspacePath });
  assert.match(mergedExternal.documents["script-1"].html, /EXTERNAL_CLI_UPDATE/u);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

// Skill 安装、测试、加载、禁用和基础能力回退在隔离数据根中真实持久化。
const skillRoot = await mkdtemp(join(tmpdir(), "shensi-v113-skill-"));
const previousDataRoot = process.env.SHENSI_DATA_ROOT;
try {
  process.env.SHENSI_DATA_ROOT = skillRoot;
  const skillStore = await import(`../src/server/skill-store.mjs?e2e=${Date.now()}`);
  const source = `---
schema_version: 2
id: v113-evidence-skill
name: v113 证据 Skill
version: 1.0.0
author: 神思验收
description: 仅用于隔离环境验证 Skill 真实加载链路。
capability_boundary: 只根据输入提供局部写作建议，不访问网络、不修改文件。
source: user
capabilities:
  - auxiliary_advisor
role: guidance
workspace_modes:
  - project
artifact_types:
  - text
input_requirements:
  - user_brief
output_contract: text_candidate
trigger_keywords:
  - 证据链
---
# 证据 Skill

读取本轮用户简报，给出一条明确、可执行且不包含内部信息的局部写作建议。
`;
  const installed = await skillStore.installSkillSource({ content: source, sourceLabel: "v113 隔离验收" });
  const tested = await skillStore.testManagedSkill({
    id: installed.skill.id,
    sandboxTest: { passed: true, summary: "隔离沙箱进程输出合同通过" },
  });
  assert.equal(tested.skill.testStatus, "passed");
  const loaded = await skillStore.loadManagedSkillSelections([installed.skill.id]);
  assert.equal(loaded.length, 1);
  assert.match(loaded[0].content, /证据 Skill/u);
  await skillStore.setManagedSkillDisabled({ id: installed.skill.id, disabled: true });
  const disabled = await skillStore.loadManagedSkillSelections([installed.skill.id]);
  assert.equal(disabled.length, 0);
} finally {
  if (previousDataRoot === undefined) delete process.env.SHENSI_DATA_ROOT;
  else process.env.SHENSI_DATA_ROOT = previousDataRoot;
  await rm(skillRoot, { recursive: true, force: true });
}

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /clipboardData/u);
assert.match(appSource, /addAttachments/u);
assert.match(appSource, /data-edit-queued/u);
assert.match(appSource, /queued-inline-editor/u);
const nativeConversationSource = appSource.slice(
  appSource.indexOf("const executeConversationAgentMessage ="),
  appSource.indexOf("const sendMessage ="),
);
assert.match(nativeConversationSource, /conversationAgentRequest\("\/api\/conversation-agent\/start"/u,
  "所有普通文字请求必须统一进入原生 Agent");
assert.match(appSource, /contractDocument\.externalContentChanged === true/u);
assert.match(nativeConversationSource, /const targetDocumentId = options\.inlineEdit\?\.documentId[\s\S]{0,420}taskDocumentAnchor\(\{ instruction: content, activeDocumentId: activeDocumentIdAtSend \}\)/u,
  "普通任务不默认绑定当前文档，只有局部编辑、明确章节或明确指代当前文档时才冻结目标");
assert.match(nativeConversationSource, /!explicitNewDocumentRequest\.create/u,
  "明确新建文档时不得沿用当前文档锚点");
assert.match(nativeConversationSource, /const currentDocumentId = activeDocumentIdAtSend/u, "当前文档仅用于指代");
assert.doesNotMatch(nativeConversationSource, /crossFormatRoute|isExplicitCrossFormatInstruction/u,
  "跨格式任务不得再由普通对话本地关键词路由抢先指定目标");
assert.match(appSource, /const landed = hasVerifiedLandingReceipt\(reply\);[\s\S]{0,900}landingStatus: verificationPending \? reply\.engineExecution\.status : landed \? "committed" : "failed"/u,
  "正式交付只能在验证回执成功后标记为 committed");
assert.match(appSource, /if \(requestId\) message\.generationAttempt = clone\(await fetchGenerationAttempt\(requestId\)/u,
  "正式落盘后必须回读并保留后台任务的完成证据");

console.log("Shensi v1.1.3 completion evidence passed");
