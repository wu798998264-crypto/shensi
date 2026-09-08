import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inspectWhiteboardTaskClarity, whiteboardTaskClarityMessage } from "../src/whiteboard-task-clarity.js";
import { isUnusableWhiteboardGenerationText, whiteboardTextGenerationRequest } from "../src/whiteboard.js";

const documentNode = (id, title = id) => ({ id, kind: "reference", reference: { type: "book", id, title } });
const skillNode = (id, title, capabilities = []) => ({
  id,
  kind: "skill",
  reference: {
    type: "skill",
    id,
    title,
    skillSelections: [{ id, name: title, authorizedCapabilities: capabilities }],
  },
});

const deconstructionSkill = skillNode("skill-book", "爆款拆书", ["knowledge_reference"]);
const novel = documentNode("book-1", "《大主宰》");
const adaptationModule = {
  id: "module-adaptation",
  kind: "skill",
  reference: {
    type: "capability",
    id: "capability:module:adapted-drama-writer",
    title: "小说改短剧主笔模块",
    skillSelections: [{ id: "builtin:adapted-script-writer", name: "小说改短剧剧本主笔", authorizedCapabilities: ["adaptation_writer"] }],
  },
};

assert.equal(inspectWhiteboardTaskClarity({
  instruction: "拆书",
  upstream: [deconstructionSkill, novel],
  selectedSkills: deconstructionSkill.reference.skillSelections,
}).requiresClarification, false, "one compatible Skill and one novel must be inferred without requiring @");

assert.equal(inspectWhiteboardTaskClarity({
  instruction: "帮我处理一下",
  upstream: [novel],
}).requiresClarification, false, "ordinary document generation without a connected Skill must retain existing flexible behavior");

assert.equal(inspectWhiteboardTaskClarity({
  instruction: "分析这篇小说并输出人物关系和剧情结构",
  upstream: [deconstructionSkill, novel],
  selectedSkills: deconstructionSkill.reference.skillSelections,
}).requiresClarification, false, "an explicit action and output object must remain executable");

assert.equal(inspectWhiteboardTaskClarity({
  instruction: "改编",
  upstream: [adaptationModule, novel],
  selectedSkills: adaptationModule.reference.skillSelections,
}).requiresClarification, false, "one connected document and one adaptation Skill must infer short commands");

assert.equal(inspectWhiteboardTaskClarity({
  instruction: "改编",
  upstream: [adaptationModule, deconstructionSkill, novel],
  selectedSkills: [...adaptationModule.reference.skillSelections, ...deconstructionSkill.reference.skillSelections],
}).requiresClarification, false, "a fuzzy action may select the unique compatible Skill when several are connected");

const vague = inspectWhiteboardTaskClarity({
  instruction: "帮我处理一下",
  upstream: [deconstructionSkill, novel, documentNode("book-2", "《另一部小说》")],
  selectedSkills: deconstructionSkill.reference.skillSelections,
});
assert.equal(vague.requiresClarification, true);
assert.equal(vague.reason, "target_document");
const vagueMessage = whiteboardTaskClarityMessage(vague);
assert.match(vagueMessage, /不是软件故障/u);
assert.match(vagueMessage, /@目标文档/u);
assert.match(vagueMessage, /爆款拆书/u, "澄清文案必须显示当前连接的 Skill，而不是固定套用无关 Skill");
assert.match(vagueMessage, /拆解对象|分析范围/u, "澄清文案必须给出与 Skill 能力对应的补充方向");
assert.doesNotMatch(vagueMessage, /canvas-node-/u, "澄清文案不得暴露白板内部节点 ID");
assert.equal(isUnusableWhiteboardGenerationText("当前任务需要补充说明\n\n请补充目标文档和任务效果"), true, "历史澄清卡不得作为正式生成内容或上游素材");

const multipleDocuments = inspectWhiteboardTaskClarity({
  instruction: "拆书",
  upstream: [deconstructionSkill, novel, documentNode("book-2", "《另一部小说》")],
  selectedSkills: deconstructionSkill.reference.skillSelections,
});
assert.equal(multipleDocuments.requiresClarification, true);
assert.equal(multipleDocuments.reason, "target_document");

assert.equal(inspectWhiteboardTaskClarity({
  instruction: "拆书",
  upstream: [deconstructionSkill, novel, documentNode("book-2", "《另一部小说》")],
  selectedSkills: deconstructionSkill.reference.skillSelections,
  explicitReferenceIds: [novel.id],
}).requiresClarification, false, "one explicit @document must resolve a multi-document input");

const unrelatedSkill = skillNode("skill-image", "电影级图片提示词", ["visual_prompt"]);
const mismatch = inspectWhiteboardTaskClarity({
  instruction: "拆书",
  upstream: [unrelatedSkill, novel],
  selectedSkills: unrelatedSkill.reference.skillSelections,
});
assert.equal(mismatch.requiresClarification, true);
assert.equal(mismatch.reason, "skill_mismatch");
assert.match(whiteboardTaskClarityMessage(mismatch), /电影级图片提示词/u, "Skill 不匹配时必须显示实际 Skill 名称");

assert.match(whiteboardTextGenerationRequest("分析这篇小说", { hasUpstream: true }), /不得声称生成失败/u);
assert.match(whiteboardTextGenerationRequest("分析这篇小说", { hasUpstream: true }), /@目标文档/u);

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /inspectWhiteboardTaskClarity\(\{[\s\S]{0,400}explicitReferenceIds:/u, "text-card generation must run the clarity preflight");
assert.doesNotMatch(appSource, /label: "等待补充明确指令"/u, "temporary clarification must not overwrite the target card");
assert.match(appSource, /Clarification is a temporary preflight result/u, "clarification handling must remain temporary");
assert.match(appSource, /任务需要补充说明：/u);
const submitSource = appSource.slice(appSource.indexOf('elements.whiteboardGenerateForm.addEventListener("submit"'));
assert.ok(
  submitSource.indexOf("inspectWhiteboardTaskClarity") < submitSource.indexOf("requestWhiteboardAutoSkillRoute"),
  "manual Skill/document ambiguity must be handled before auto routing can fail or start another request",
);
assert.match(
  submitSource,
  /requestWhiteboardAutoSkillRoute[\s\S]{0,1400}routedPreflightContext[\s\S]{0,300}clarifyTaskIfNeeded\(routedPreflightContext\)/u,
  "auto-routed Skill/document relationships must be checked again before model generation",
);

console.log("Whiteboard task clarity tests passed");
