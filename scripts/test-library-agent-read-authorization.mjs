import assert from "node:assert/strict";
import { compileServerVerifiedContext } from "../src/server/server-context-verifier.mjs";
import { createServerContextReadBroker } from "../src/server/context-read-broker.mjs";

const documents = {
  "chapter-1": { id: "chapter-1", title: "第一章", moduleId: "manuscript", html: "<p>正文事实：雨停了。</p>" },
  "library-reference": { id: "library-reference", title: "参考资料", moduleId: "library", markdown: "资料事实：旧港在北岸。" },
  "library-memo": { id: "library-memo", title: "备忘录", moduleId: "library", readPolicy: "explicit-only", markdown: "备忘事实：林岚不能读取梦境。" },
  "foreign-library": { id: "foreign-library", title: "外部资料", projectId: "other-project", moduleId: "library", markdown: "不应跨作品读取。" },
};

const marker = (id, text) => `<!-- shensi-context-source ${JSON.stringify({ id, required: true, authority: "reference" })} -->\n${text}`;

const ordinary = compileServerVerifiedContext({
  suppliedContext: marker("library-reference", "资料事实：旧港在北岸。"),
  documents,
  prompt: "继续写第一章",
  targetDocumentId: "chapter-1",
  fullDocumentIds: ["library-reference", "library-memo"],
});
assert.ok(!ordinary.includedIds.includes("library-reference"), "普通任务不得自动读取资料库");
assert.ok(!ordinary.includedIds.includes("library-memo"), "备忘录默认不得读取");

const explicit = compileServerVerifiedContext({
  suppliedContext: "",
  documents,
  prompt: "请读取参考资料",
  targetDocumentId: "chapter-1",
  explicitReferenceDocumentIds: ["library-reference"],
  fullDocumentIds: ["library-reference"],
});
assert.ok(explicit.includedIds.includes("library-reference"), "用户明确引用后应允许读取资料库");

const semantic = compileServerVerifiedContext({
  suppliedContext: "",
  documents,
  prompt: "根据语义计划整理人物",
  targetDocumentId: "chapter-1",
  agentRequestedDocumentIds: ["library-memo"],
  fullDocumentIds: ["library-memo"],
});
assert.ok(semantic.includedIds.includes("library-memo"), "Agent 语义 readPlan 应允许读取显式资料");

const forgedFullList = compileServerVerifiedContext({
  suppliedContext: "",
  documents,
  prompt: "普通任务",
  targetDocumentId: "chapter-1",
  fullDocumentIds: ["library-reference"],
});
assert.ok(!forgedFullList.includedIds.includes("library-reference"), "单独伪造 fullDocumentIds 不得绕过策略");

const broker = createServerContextReadBroker({
  documents,
  project: { id: "current-project", documentIds: Object.keys(documents) },
  target: { projectId: "current-project", documentId: "chapter-1", domain: "novel", instruction: "读取备忘录" },
  agentRequestedDocumentIds: ["library-memo"],
});
const brokerResult = await broker({
  request: {
    sufficient: false,
    needs: [{ id: "memo", need: "读取备忘事实", query: "林岚限制", sourceKinds: ["reference"], preferredDocumentIds: ["library-memo"], blocking: true }],
  },
});
assert.ok(brokerResult.manifest.included.some((item) => item.id === "library-memo"), "可信补读代理应按 Agent 语义计划读取资料");
assert.ok(!brokerResult.manifest.included.some((item) => item.id === "foreign-library"), "补读代理不得跨作品读取资料");

console.log("Library Agent read authorization tests passed");
