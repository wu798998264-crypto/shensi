import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { compileContextSections } from "../src/context-compiler.js";
import {
  buildExecutionSourceReceipt,
  executionSourceMarker,
} from "../src/server/execution-source-proof.mjs";
import { loadAgentSkillContext } from "../src/server/agent-skill-context.mjs";
import { compileAgentSkillFallbackPolicy } from "../src/agent-skill-fallback-policy.js";
import { skillPromptForStage, withChatModelCapabilityFallback } from "../src/skill-routing.js";

const longDocument = `开头证据\n${"正文细节".repeat(9_000)}\n结尾证据`;
const compiled = compileContextSections({
  ids: ["chapter-8"],
  requiredIds: ["chapter-8"],
  fullDocumentIds: ["chapter-8"],
  titleFor: () => "第8章",
  contentFor: () => longDocument,
  maxCharacters: longDocument.length + 2_000,
  perDocumentLimit: 6_000,
});
assert.deepEqual(compiled.includedIds, ["chapter-8"]);
assert.deepEqual(compiled.truncatedIds, []);
assert.match(compiled.text, /开头证据/u);
assert.match(compiled.text, /结尾证据/u);
assert.equal(compiled.manifest[0].fullText, true);
assert.equal(compiled.manifest[0].characters, longDocument.length);

const insufficient = compileContextSections({
  ids: ["chapter-8"],
  requiredIds: ["chapter-8"],
  fullDocumentIds: ["chapter-8"],
  titleFor: () => "第8章",
  contentFor: () => longDocument,
  maxCharacters: 8_000,
  perDocumentLimit: 6_000,
});
assert.deepEqual(insufficient.includedIds, ["chapter-8"]);
assert.deepEqual(insufficient.missingRequiredIds, []);
assert.equal(insufficient.manifest[0].fullText, true);
assert.equal(insufficient.manifest[0].compressed, true);
assert.equal(insufficient.manifest[0].sourceCharacters, longDocument.length);
assert.match(insufficient.text, /全文读取压缩回执/u);

const skillContent = "必须保留这个唯一 Skill 证据。";
const documentContent = "必须读取当前文档的真实全文，而不是目录摘要。";
const skillMarker = executionSourceMarker({ kind: "skill", id: "skill:writer", content: skillContent, version: "1.0.0" });
const documentMarker = executionSourceMarker({ kind: "document", id: "chapter-8", content: documentContent, revision: "r8" });
const receipt = buildExecutionSourceReceipt({
  system: `${skillMarker}\n${skillContent}\n${documentMarker}\n${documentContent}`,
  sources: [
    { kind: "skill", id: "skill:writer", content: skillContent, version: "1.0.0" },
    { kind: "document", id: "chapter-8", content: documentContent, revision: "r8" },
  ],
});
assert.equal(receipt.verified, true);
assert.equal(receipt.sources.every((item) => item.fullText === true), true);
assert.throws(() => buildExecutionSourceReceipt({
  system: `${documentMarker}\n当前文档摘要`,
  sources: [{ kind: "document", id: "chapter-8", content: documentContent, revision: "r8" }],
}), /没有完整进入最终模型输入|来源标记与实际全文不一致/u);
const emptyTargetReceipt = buildExecutionSourceReceipt({
  system: "仅执行新建白板卡片，不读取空目标文档。",
  sources: [{ kind: "document", id: "whiteboard-empty", content: "" }],
});
assert.deepEqual(emptyTargetReceipt.sources, [], "空白目标文档不能被当作缺失全文证据而阻断卡片生成");
assert.equal(emptyTargetReceipt.verified, false);

const agentContext = await loadAgentSkillContext({
  selectedSkills: [{ id: "official:writer" }],
  loadSkills: async () => [{
    id: "official:writer",
    name: "真实主笔",
    version: "2.0.0",
    content: skillContent,
    contentHash: "",
  }],
});
assert.equal(agentContext.loadedSkills[0].contentLength, skillContent.length);
assert.equal(agentContext.loadedSkills[0].fullText, true);
assert.match(agentContext.contextBlocks[0].text, /shensi-execution-source/u);
assert.match(agentContext.contextBlocks[0].text, /必须保留这个唯一 Skill 证据/u);

const incompleteAgentContext = await loadAgentSkillContext({
  selectedSkills: [{ id: "official:writer" }],
  loadSkills: async () => [{
    id: "official:writer",
    name: "缺少必读规则的主笔",
    version: "2.0.0",
    content: skillContent,
    skillReadFailures: [{ path: "rules/mandatory.md", reason: "missing" }],
  }],
});
assert.equal(incompleteAgentContext.loadedSkills[0].fullText, false);
assert.deepEqual(incompleteAgentContext.missingIds, ["official:writer"]);
assert.deepEqual(incompleteAgentContext.contextBlocks, []);
const explicitMissingPolicy = compileAgentSkillFallbackPolicy({
  instruction: "请使用这个 Skill 写作",
  requestedSkills: [{ id: "official:writer", source: "explicit" }],
  loadedSkillIds: [],
  explicitSkillIds: ["official:writer"],
});
assert.equal(explicitMissingPolicy.terminal, false, "缺失或禁用的显式 Skill 必须降级为 Agent 原生能力，不能阻断任务");
assert.equal(explicitMissingPolicy.nativeFallback, true);
assert.equal(explicitMissingPolicy.runnableSubtasks.length, 1);
const automaticMissingPolicy = compileAgentSkillFallbackPolicy({
  instruction: "继续写当前章节",
  requestedSkills: [{ id: "official:writer", source: "automatic" }],
  loadedSkillIds: [],
  explicitSkillIds: [],
});
assert.equal(automaticMissingPolicy.terminal, false);
assert.deepEqual(automaticMissingPolicy.missingAutomaticSkillIds, ["official:writer"]);

let disabledLoaderCalled = false;
const disabledAgentContext = await loadAgentSkillContext({
  selectedSkills: [{ id: "official:disabled-writer", enabled: false }],
  loadSkills: async () => {
    disabledLoaderCalled = true;
    return [{ id: "official:disabled-writer", content: "不应读取" }];
  },
});
assert.equal(disabledLoaderCalled, false, "禁用 Skill 不得进入真实全文加载器");
assert.deepEqual(disabledAgentContext.requestedIds, []);
assert.deepEqual(disabledAgentContext.loadedSkills, []);

const nativeCapabilityFallback = withChatModelCapabilityFallback({
  blockingTemplateCapabilities: ["novel_prose_writer"],
  missingTemplateCapabilities: ["effect_reviewer"],
  invalidTemplateCapabilities: [],
  compiledCapabilityPlan: {
    capabilityStatus: [
      { capabilityId: "novel_prose_writer", status: "template_declared_not_activated" },
      { capabilityId: "effect_reviewer", status: "template_capability_missing" },
    ],
    trace: [],
  },
}, { executionSurface: "agent" });
assert.deepEqual(nativeCapabilityFallback.blockingTemplateCapabilities, []);
assert.deepEqual(nativeCapabilityFallback.modelFallbackCapabilities.sort(), ["effect_reviewer", "novel_prose_writer"],
  "主笔或自检 Skill 被禁用、缺失或不完整时，必须明确交给当前 Agent 原生能力补位");
assert.equal(nativeCapabilityFallback.modelNativeAssistance, true);
assert.equal(nativeCapabilityFallback.compiledCapabilityPlan.capabilityStatus.every((item) => item.status === "model_runtime_fallback"), true);
const nativeFallbackPrompt = skillPromptForStage(nativeCapabilityFallback, "evaluation");
assert.match(nativeFallbackPrompt, /只允许使用下方已由神思完整加载并带来源凭证的启用 Skill/u);
assert.match(nativeFallbackPrompt, /其他全局 Skill、已禁用 Skill、缺失 Skill 或不完整 Skill 均不得打开、调用/u,
  "外部 Agent 自行发现的全局 Skill 也必须被最终输入限制为不可调用");
assert.match(nativeFallbackPrompt, /effect_reviewer、novel_prose_writer|novel_prose_writer、effect_reviewer/u);

const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
assert.match(serverSource, /agentSkillContext\.loadedSkills\.filter\(\(skill\) => skill\.fullText === true\)/u, "Agent 只能把完整 Skill 视为已加载");
assert.match(serverSource, /const completeSelectedSkills = selectedSkills\.filter\(skillSourceIsComplete\)/u, "Chat 必须使用同一完整来源门禁");
assert.match(serverSource, /skills: completeSelectedSkills/u, "不完整 Skill 不得进入 Chat 运行时");

console.log("Shensi full Skill/document source loading tests passed");
