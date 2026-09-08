import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { conversationMessageEligibleForModel } from "../src/conversation-context.js";
import { skillFallbackRecoveryDecision } from "../src/agent-skill-fallback-policy.js";
import { CREATIVE_GUIDANCE_DOCUMENT_ID, creativeGuidanceLandingTarget } from "../src/creative-guidance-record.js";

assert.equal(conversationMessageEligibleForModel({
  role: "assistant",
  content: "隐藏候选稿",
  candidate: "隐藏候选稿",
  candidateBranchGroupId: "group-1",
  candidateBranchVersionId: "v1",
  candidateBranchActive: false,
}), false, "未显示的候选稿不得进入上下文");
assert.equal(conversationMessageEligibleForModel({
  role: "assistant",
  content: "当前候选稿",
  candidate: "当前候选稿",
  candidateBranchGroupId: "group-1",
  candidateBranchVersionId: "v2",
  candidateBranchActive: true,
}), true, "当前显示候选稿必须进入上下文");

assert.deepEqual(skillFallbackRecoveryDecision({ code: "SKILL_REFERENCE_UNAVAILABLE", missingSkillIds: ["writer"] }), {
  action: "ask",
  options: ["retry", "choose_other", "continue_without"],
  missingSkillIds: ["writer"],
});
assert.equal(creativeGuidanceLandingTarget({ requestMode: "creative_guidance", target: { documentId: "chapter-8" } }).documentId, CREATIVE_GUIDANCE_DOCUMENT_ID);
assert.equal(creativeGuidanceLandingTarget({ requestMode: "creative", target: { documentId: "chapter-8" } }).documentId, "chapter-8");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.doesNotMatch(app, /proof\.created\s*&&\s*genericLandingDocumentTitle\(proof\.title\)/u, "新建正文不得因标题未命名而整单回滚");
assert.doesNotMatch(app, /!proof\.title[\s\S]{0,120}proof\.previousHash/u, "续写不得把标题作为正文交付前置条件");
assert.match(app, /正文已成功写入，标题暂未生成，可稍后补写/u, "标题缺失时必须明确正文已成功且允许后补标题");
assert.match(app, /kind:\s*"skill_recovery"/u, "Skill 缺失必须进入对话内恢复选择，而不是硬错误");
assert.match(app, /CREATIVE_GUIDANCE_DOCUMENT_ID[\s\S]{0,160}landingMode:\s*"append_report"/u, "创作引导推演记录必须只写入创作引导文档");

console.log("Shensi v2.85 final rule convergence tests passed");
