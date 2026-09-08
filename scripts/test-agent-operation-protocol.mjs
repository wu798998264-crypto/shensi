import assert from "node:assert/strict";
import {
  AGENT_OPERATION_IMPACT,
  AGENT_OPERATION_KINDS,
  createAgentOperationProposal,
  extractConversationSkillText,
  skillPanelBindingCapabilities,
  skillTargetModuleForCapabilities,
} from "../src/agent-operation-protocol.js";

const skill = `---
schema_version: 2
id: user.short-drama-check
name: 短剧自检
version: 1.0.0
author: 作者
description: 检查短剧成稿
capability_boundary: 只检查候选，不修改正文
capabilities:
  - effect_reviewer
workspace_modes:
  - project
---
# 检查规则
检查冲突、节奏和集尾钩子。`;

assert.equal(extractConversationSkillText({ prompt: "请导入这个 Skill", attachments: [{ name: "短剧.md", mimeType: "text/markdown", text: skill }] }).content, skill);
assert.equal(extractConversationSkillText({ prompt: "请导入这个 Skill", attachments: [{ name: "短剧.skill", mimeType: "text/markdown", text: skill }] }).content, skill);
assert.equal(extractConversationSkillText({ prompt: `${skill}\n\n请导入这个 Skill` }).content, `${skill}\n\n请导入这个 Skill`);
assert.equal(skillTargetModuleForCapabilities(["effect_reviewer"]), "module:novel-review");
assert.equal(skillTargetModuleForCapabilities(["effect_reviewer"], "短剧自检"), "module:short-drama-review");
assert.deepEqual(skillPanelBindingCapabilities(["effect_reviewer", "genre_reviewer"]), ["effect_reviewer", "genre_reviewer"]);
const proposal = createAgentOperationProposal({
  kind: AGENT_OPERATION_KINDS.SKILL_INSTALL,
  title: "确认插入 Skill",
  impact: AGENT_OPERATION_IMPACT.HIGH,
  deliverables: [{ kind: "skill", targetDocument: "短剧自检" }],
});
assert.equal(proposal.completionStatus, "awaiting_confirmation");
assert.equal(proposal.deliverables[0].status, "pending");
assert.deepEqual(proposal.exclusions, []);
console.log("agent operation protocol regressions passed");
