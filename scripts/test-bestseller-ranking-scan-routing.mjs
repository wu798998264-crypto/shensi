import assert from "node:assert/strict";
import { resolve } from "node:path";
import { DEFAULT_CUSTOM_SKILL_SLOTS } from "../src/module-registry.js";
import { classifyRequestMode, isBookDeconstructionRequest } from "../src/request-routing.js";
import { requestedArtifactTarget } from "../src/artifact-target.js";
import { loadAgentSkillContext } from "../src/server/agent-skill-context.mjs";
import { loadSelectedSkills } from "../src/server/skill-library.mjs";

const scan = classifyRequestMode({ text: "扫一下起点男频新书榜" });
assert.equal(scan.mode, "market_research");
assert.equal(scan.deliverableType, "market_scan_report");
assert.equal(scan.requiresToolTask, true);
const knowledge = classifyRequestMode({ text: "爆款扫榜有什么用" });
assert.equal(knowledge.mode, "general");
assert.equal(knowledge.requiresToolTask, undefined);
assert.equal(isBookDeconstructionRequest({ text: "爆款拆书" }), true);
assert.notEqual(classifyRequestMode({ text: "写第一章" }).deliverableType, "market_scan_report");
assert.equal(requestedArtifactTarget("爆款扫榜"), null, "扫榜报告默认不得获得落盘目标");
const slot = DEFAULT_CUSTOM_SKILL_SLOTS.find((item) => item.id === "bestseller-ranking-scan");
assert.ok(slot);
assert.equal(slot.enabled, true);
assert.ok(slot.capabilities.includes("ranking_scan"));
const skillContext = await loadAgentSkillContext({
  selectedSkills: [{ id: "official:bestseller-ranking-scan" }],
  loadSkills: loadSelectedSkills,
  shensiRoot: resolve(import.meta.dirname, "..", "packaging", "bundled", "skill", "神思"),
});
assert.deepEqual(skillContext.missingIds, []);
assert.equal(skillContext.loadedSkills[0]?.fullText, true);
assert.deepEqual(skillContext.loadedSkills[0]?.ruleFiles?.map((item) => item.path).sort(), [
  "references/data-quality.md",
  "references/long-scan-framework.md",
  "references/output-template.md",
  "references/short-scan-framework.md",
]);
assert.match(skillContext.contextBlocks[0]?.text || "", /Skill 必读规则文件：references\/data-quality\.md/u);
console.log("Bestseller ranking scan routing tests passed");
