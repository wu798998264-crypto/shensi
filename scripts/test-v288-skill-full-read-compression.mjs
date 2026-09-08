import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { compactFullyReadContextContent } from "../src/context-compiler.js";
import { loadAgentSkillContext } from "../src/server/agent-skill-context.mjs";

const fullSkill = `# 超长主笔 Skill\n${"- 必须保留人物动机；禁止机械选择。\n".repeat(10_000)}# 结尾规则\n不得阻断正式写作。`;
const compacted = compactFullyReadContextContent(fullSkill, 18_000, {
  query: "必须 禁止 不得 规则",
  label: "超长主笔 Skill",
});
assert.equal(compacted.fullText, true);
assert.equal(compacted.compressed, true);
assert.equal(compacted.sourceCharacters, fullSkill.trim().length);
assert.ok(compacted.chunksRead > 1);
assert.match(compacted.text, /全文读取压缩回执/u);
assert.match(compacted.text, /不得阻断正式写作/u);

const context = await loadAgentSkillContext({
  selectedSkills: [{ id: "official:long-writer" }],
  loadSkills: async () => [{
    id: "official:long-writer",
    name: "超长主笔",
    content: compacted.text,
    sourceContentLength: fullSkill.length,
    chunksRead: compacted.chunksRead,
    compressed: true,
    fullSourceRead: true,
    truncated: false,
    skillReadFailures: [],
  }],
});
assert.deepEqual(context.missingIds, []);
assert.equal(context.loadedSkills[0]?.fullText, true, "完整读取后压缩的 Skill 必须通过运行门禁");
assert.equal(context.contextBlocks.length, 1);

const source = await readFile(new URL("../src/server/skill-library.mjs", import.meta.url), "utf8");
assert.doesNotMatch(source, /rule_budget_exceeded/u, "超预算不得伪装成 Skill 读取失败");
assert.doesNotMatch(source, /originalContent\.length\s*>\s*MAX_SKILL_CHARS/u, "超长 Skill 不得被直接跳过");
const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
assert.match(serverSource, /const fullyRead = text \? compactFullyReadContextContent\(text,/u, "Agent 文档必须进入全文读取压缩器");
assert.match(serverSource, /fullSourceRead: fullyRead\?\.fullText === true/u, "Agent 文档必须携带全文已读回执");

console.log("Shensi v2.88 Skill full-read compression tests passed");
