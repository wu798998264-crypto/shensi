import assert from "node:assert/strict";

import {
  buildContextSourceManifest,
  contextSourceIsolationDecision,
} from "../src/context-manifest.js";
import { conversationMessageEligibleForModel } from "../src/conversation-context.js";

const excluded = [
  { kind: "deleted_content", id: "trash-1", content: "回收站秘密", deleted: true },
  { kind: "historical_conversation", id: "old-chat", content: "其他历史对话", historical: true },
  { kind: "candidate", id: "candidate-hidden", content: "未选候选稿", active: false },
  { kind: "conversation_branch", id: "branch-hidden", content: "隐藏分支", active: false },
  { kind: "document", id: "other-work", content: "其他作品正文", crossWorkspace: true },
  { kind: "skill", id: "disabled-skill", content: "禁用规则", disabled: true },
];

for (const source of excluded) {
  const decision = contextSourceIsolationDecision(source);
  assert.equal(decision.allowed, false, `${source.kind} 默认必须隔离`);
  assert.ok(decision.reason);
}

assert.equal(contextSourceIsolationDecision({
  ...excluded[0],
  explicitAuthorization: "recover_deleted_content",
}).allowed, true, "明确找回指定删除内容时才允许读取");
assert.equal(contextSourceIsolationDecision({
  ...excluded[1],
  explicitlyReferenced: true,
}).allowed, true, "用户明确回指时才允许读取其他历史对话");
assert.equal(contextSourceIsolationDecision({
  ...excluded[2],
  comparisonRequested: true,
}).allowed, true, "用户明确要求比较时才允许读取未选候选");
assert.equal(contextSourceIsolationDecision({
  ...excluded[4],
  explicitlyReferenced: true,
}).allowed, true, "用户明确要求跨作品对照时才允许读取");
assert.equal(contextSourceIsolationDecision({
  ...excluded[5],
  explicitlyReferenced: true,
}).allowed, false, "禁用 Skill 即使被旧状态引用也不得加载");

const manifest = buildContextSourceManifest({ requestId: "isolation", sources: excluded });
assert.equal(manifest.included.length, 0);
assert.equal(manifest.excluded.length, excluded.length);
assert.deepEqual(new Set(manifest.excluded.map((item) => item.id)), new Set(excluded.map((item) => item.id)));

assert.equal(conversationMessageEligibleForModel({ role: "assistant", candidate: "未选稿", candidateBranchActive: false }), false);
assert.equal(conversationMessageEligibleForModel({ role: "assistant", content: "隐藏分支", branchActive: false }), false);
assert.equal(conversationMessageEligibleForModel({ role: "assistant", content: "被撤回", rolledBack: true }), false);

console.log("Shensi v3.0 context isolation sentinel tests passed");
