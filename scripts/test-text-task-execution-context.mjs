import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  compileNativeAgentDocumentReadManifest,
  compileTextTaskExecutionContext,
  normalizeTextTaskExecutionContext,
} from "../src/text-task-execution-context.js";
import { preloadConversationAgentExperience, preloadConversationAgentReadManifest } from "../src/server/conversation-agent-service.mjs";

const documents = {
  "index-language-blacklist": { title: "创作合同", markdown: "# 创作合同\n\n## 项目禁用词\n\n当前没有项目级禁用词。\n\n## 特别注意事项\n\n当前没有项目级特别注意事项。" },
  "chapter-3": { title: "第三章", markdown: "第三章当前草稿", displayCharacterCount: 8 },
  "chapter-2": { title: "第二章", markdown: "第二章正文" },
  "chapter-1": { title: "第一章", markdown: "第一章正文" },
  "outline-chapter-3": { title: "第三章章纲", markdown: "本章目标" },
  "outline-series": { title: "全集大纲", markdown: "全书方向" },
  "memory-snapshot": { title: "当前状态", markdown: "人物仍在旧城区" },
  "memory-foreshadowing": { title: "伏笔管理", markdown: "钥匙尚未回收" },
  "memory-release": { title: "信息释放", markdown: "主角尚未知情" },
};

const emptyContractManifest = compileNativeAgentDocumentReadManifest({
  documents,
  targetDocumentId: "chapter-3",
  taskRoute: {
    mode: "creative",
    intentEnvelope: { taskType: "writing", writeMode: "formal_auto", requiredContextDocumentIds: [] },
  },
});
assert.equal(emptyContractManifest.creativeContractReadRequired, false, "默认空合同不得进入正式任务读取清单");
assert.equal(emptyContractManifest.requiredDocumentIds.includes("index-language-blacklist"), false, "默认空合同不得被读取");

const substantiveContractDocuments = {
  ...documents,
  "index-language-blacklist": {
    title: "创作合同",
    markdown: "# 创作合同\n\n## 项目禁用词\n\n禁止使用空泛的成功学结论。\n\n## 特别注意事项\n\n必须保持三体人的技术限制连续。",
  },
};
const formalContractManifest = compileNativeAgentDocumentReadManifest({
  documents: substantiveContractDocuments,
  targetDocumentId: "chapter-3",
  taskRoute: {
    mode: "creative",
    intentEnvelope: { taskType: "writing", writeMode: "formal_auto", requiredContextDocumentIds: [] },
  },
});
assert.equal(formalContractManifest.creativeContractReadRequired, true, "正式写作必须读取非空创作合同");
assert.ok(formalContractManifest.requiredDocumentIds.includes("index-language-blacklist"), "非空创作合同必须进入必读清单");
assert.equal(formalContractManifest.entries.find((entry) => entry.documentId === "index-language-blacklist")?.required, true);

const guidanceContractManifest = compileNativeAgentDocumentReadManifest({
  documents: substantiveContractDocuments,
  targetDocumentId: "chapter-3",
  taskRoute: {
    mode: "creative_guidance",
    intentEnvelope: { taskType: "planning", writeMode: "conversation_only", requiredContextDocumentIds: [] },
  },
});
assert.equal(guidanceContractManifest.creativeContractReadRequired, false, "创作引导不应强制读取正式合同");
assert.equal(guidanceContractManifest.requiredDocumentIds.includes("index-language-blacklist"), false, "创作引导不应自动读取创作合同");

const manifest = compileNativeAgentDocumentReadManifest({
  documents,
  targetDocumentId: "chapter-3",
  explicitDocumentIds: ["outline-series"],
  taskRoute: { contextDomain: "novel", intentEnvelope: { requiredContextDocumentIds: ["outline-chapter-3"] } },
});
assert.equal(manifest.memorySkillRequired, false, "续写读取记忆文档不得等同于调用记忆 Skill");
assert.equal(manifest.memoryDocumentsPlanned, true);
assert.ok(manifest.priorityDocumentIds.includes("memory-snapshot"));
assert.ok(manifest.priorityDocumentIds.includes("memory-foreshadowing"));
assert.ok(manifest.priorityDocumentIds.includes("chapter-2"));
assert.ok(manifest.requiredDocumentIds.includes("chapter-3"));
assert.ok(manifest.requiredDocumentIds.includes("outline-chapter-3"));
assert.equal(manifest.entries.find((entry) => entry.documentId === "chapter-3")?.displayCharacterCount, 8);

const context = compileTextTaskExecutionContext({
  taskContextSnapshot: {
    taskId: "task-1",
    workspaceKind: "project",
    workspaceIdentity: "project:e:/novel",
    workspacePath: "E:/Novel",
    workspaceName: "作品",
    activeDocumentId: "chapter-3",
    boundDocumentId: "chapter-3",
    documentTitle: "第三章",
    documentRevision: "rev-3",
    documentContentHash: "hash-3",
    capturedAt: "2026-09-19T00:00:00.000Z",
  },
  sourceMessageId: "message-1",
  targetDocumentId: "chapter-3",
  taskRoute: {
    taskKind: "formal_creation",
    mode: "creative",
    deliverableType: "novel",
    selectedTopLevelPlacementId: "place:novel",
    selectedModulePlacementId: "place:novel:writer",
    selectedSkillPlacementIds: ["place:novel:writer:skill"],
  },
  readManifest: manifest,
});
assert.equal(context.target.documentId, "chapter-3");
assert.equal(context.target.revision, "rev-3");
assert.equal(context.route.taskKind, "formal_creation");
assert.match(context.idempotencyKey, /^text-task:project:e:\/novel:task-1$/u);
assert.deepEqual(normalizeTextTaskExecutionContext(context).readManifest.priorityDocumentIds, manifest.priorityDocumentIds);

const sourceBodies = new Map([
  ["chapter-3", "第三章当前草稿"],
  ["chapter-2", "第二章正文"],
  ["chapter-1", "第一章正文"],
  ["outline-chapter-3", "本章目标"],
  ["outline-series", "全书方向"],
  ["memory-snapshot", "人物仍在旧城区"],
  ["memory-foreshadowing", "钥匙尚未回收"],
  ["memory-release", "主角尚未知情"],
]);
const readEvents = [];
const preloaded = await preloadConversationAgentReadManifest({
  executionContext: context,
  tools: {
    invoke: async ({ arguments: args }) => {
      const content = sourceBodies.get(args.documentId);
      const payload = content === undefined
        ? { documentId: args.documentId, status: "missing" }
        : { documentId: args.documentId, title: documents[args.documentId]?.title, status: "content", content, totalCharacters: content.length, nextStart: null };
      return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(payload) }] };
    },
  },
  emit: async (type, payload) => readEvents.push({ type, payload }),
});
assert.ok(preloaded.contextBlocks.some((block) => block.text.includes("人物仍在旧城区")), "记忆正文必须真实进入 Agent 上下文");
assert.ok(preloaded.contextBlocks.some((block) => block.text.includes("界面显示字数：8 字")), "桌面编辑器冻结的字数口径必须进入 Agent 上下文");
assert.ok(preloaded.report.completeDocumentIds.includes("memory-snapshot"));
assert.ok(readEvents.some((event) => event.type === "resource_read" && event.payload.id === "memory-snapshot" && event.payload.fullText === true), "完整预读必须产生可见读取证据");
assert.equal(preloaded.report.memorySkillRequired, false);

const formalContext = compileTextTaskExecutionContext({
  ...context,
  taskRoute: {
    ...context.route,
    mode: "creative",
    taskKind: "writing",
    writeMode: "formal_auto",
    intentEnvelope: { taskType: "writing", writeMode: "formal_auto" },
  },
  readManifest: formalContractManifest,
});
const formalReadEvents = [];
const formalPreloaded = await preloadConversationAgentReadManifest({
  executionContext: formalContext,
  tools: {
    invoke: async ({ arguments: args }) => {
      const content = args.documentId === "index-language-blacklist"
        ? substantiveContractDocuments[args.documentId].markdown
        : sourceBodies.get(args.documentId);
      const payload = content === undefined
        ? { documentId: args.documentId, status: "missing" }
        : { documentId: args.documentId, title: documents[args.documentId]?.title || "创作合同", status: "content", content, totalCharacters: content.length, nextStart: null };
      return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(payload) }] };
    },
  },
  emit: async (type, payload) => formalReadEvents.push({ type, payload }),
});
assert.ok(formalPreloaded.report.completeDocumentIds.includes("index-language-blacklist"), "正式写作必须完成读取创作合同");
assert.ok(formalReadEvents.some((event) => event.type === "resource_read" && event.payload.id === "index-language-blacklist" && event.payload.fullText === true), "创作合同完整读取必须产生可见证据");

const adoptedExperienceContext = {
  ...formalContext,
  adoptedExperienceIds: ["experience-1"],
};
const experienceReadEvents = [];
const experiencePreloaded = await preloadConversationAgentExperience({
  executionContext: adoptedExperienceContext,
  tools: {
    invoke: async ({ namespace, tool, arguments: args }) => {
      assert.equal(namespace, "experience");
      assert.equal(tool, "read");
      assert.deepEqual(args.recordIds, ["experience-1"]);
      return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ records: [{ id: "experience-1", title: "节奏经验", observation: "每场只保留一个主要转折", recommendation: "在场景末尾保留可验证的推进动作", conditions: ["正式正文"], exclusions: [], version: 2 }], missingIds: [] }) }] };
    },
  },
  emit: async (type, payload) => experienceReadEvents.push({ type, payload }),
});
assert.ok(experiencePreloaded.contextBlocks[0]?.text.includes("每场只保留一个主要转折"), "明确采用的经验正文必须进入 Agent 上下文");
assert.ok(experienceReadEvents.some((event) => event.type === "resource_read" && event.payload.kind === "experience" && event.payload.id === "experience-1"), "经验读取必须产生可见回执");
const guidanceExperience = await preloadConversationAgentExperience({
  executionContext: { ...adoptedExperienceContext, route: { ...adoptedExperienceContext.route, mode: "creative_guidance", taskType: "planning", writeMode: "conversation_only" } },
  tools: { invoke: async () => { throw new Error("创作引导不应调用经验读取"); } },
});
assert.equal(guidanceExperience.contextBlocks.length, 0, "创作引导不得强制读取明确采用经验");

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const serviceSource = await readFile(new URL("../src/server/conversation-agent-service.mjs", import.meta.url), "utf8");
const toolsSource = await readFile(new URL("../src/server/conversation-agent-tools.mjs", import.meta.url), "utf8");
assert.match(appSource, /textTaskExecutionContext\s*=\s*frontendRouteCanUseGeneralLane\(frontendRoute\)\s*\?\s*null\s*:\s*compileTextTaskExecutionContext\(/u, "原生 Agent 入口必须编译统一文字任务合同");
assert.match(appSource, /textTaskExecutionContext,\s*\n\s*readManifest:\s*nativeDocumentReadManifest/u, "原生 Agent 入口必须发送统一文字任务合同与资料读取清单");
assert.match(appSource, /event\.type === "read_manifest"[\s\S]{0,180}documentReadManifest/u, "任务卡必须接收服务端确认的读取清单");
assert.match(serviceSource, /const preloadedDocuments = await preloadConversationAgentReadManifest\(/u, "服务端必须真实预读清单文档");
assert.match(serviceSource, /name: "本轮统一文字任务执行合同"/u, "统一文字任务合同必须进入最终模型上下文");
assert.match(serviceSource, /memorySkillRequired:\s*false/u, "读取记忆文档不得被改写为强制调用记忆 Skill");
assert.match(appSource, /adoptedExperienceIds:/u, "任务快照必须冻结用户明确采用的经验ID");
assert.match(serviceSource, /preloadConversationAgentExperience\(/u, "服务端必须预读取明确采用的创作经验");
assert.match(toolsSource, /namespace\("experience"/u, "Agent 必须提供受授权限制的经验读取工具");

console.log("Unified text task execution context passed");
