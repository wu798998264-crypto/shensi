import assert from "node:assert/strict";

import {
  compileWritingStyleConstraints,
  writingStyleRulesPrompt,
} from "../src/writing-style-constraints.js";
import {
  scanWritingRepetition,
  scanWritingBatch,
} from "../src/writing-repetition-scanner.js";
import {
  applyWritingStyleReplacements,
  buildWritingStyleRevisionRequest,
  runWritingStyleQualityControl,
} from "../src/writing-style-revision.js";

const constraints = compileWritingStyleConstraints({
  currentInstruction: "这一章允许“仿佛”出现一次，但不要再使用“似乎”。",
  creativeContractRules: [
    { type: "word", value: "仿佛", maxOccurrences: 0, source: "creative_contract" },
    { type: "word", value: "似乎", maxOccurrences: 2, source: "creative_contract" },
  ],
  explicitSkills: [{
    id: "skill:writer",
    name: "主笔",
    content: "禁止使用“仿佛”。固定句式“不是……而是……”最多出现一次。",
    ruleFiles: [{ path: "references/style.md", hash: "style-hash", content: "避免使用“命运的齿轮”。" }],
  }],
  automaticSkills: [{ id: "skill:auto", name: "自动文风", content: "“仿佛”最多出现三次。" }],
  defaultRules: [{ type: "word", value: "仿佛", maxOccurrences: 4, source: "shensi_default" }],
});

const byValue = new Map(constraints.rules.map((rule) => [rule.value, rule]));
assert.equal(byValue.get("仿佛")?.maxOccurrences, 1, "当前指令必须覆盖合同、显式 Skill、自动 Skill 与默认规则");
assert.equal(byValue.get("仿佛")?.source, "current_instruction");
assert.equal(byValue.get("似乎")?.maxOccurrences, 0, "当前否定指令必须覆盖旧频率限制");
assert.equal(byValue.get("命运的齿轮")?.source, "explicit_skill", "Skill 必读文件中的原文规则必须进入本轮");
assert.equal(byValue.get("不是……而是……")?.type, "sentence_pattern");
assert.deepEqual(constraints.trace.loadedSkills, ["skill:writer", "skill:auto"]);
assert.deepEqual(constraints.trace.ruleFiles, ["references/style.md"]);
assert.match(writingStyleRulesPrompt(constraints), /仿佛.*最多 1 次/u);
assert.doesNotMatch(writingStyleRulesPrompt(constraints), /完整 Skill/u, "生成前只注入压缩后的有效规则清单");

const continuation = scanWritingRepetition({
  taskKind: "continuation",
  generatedText: "雨幕仿佛一堵墙。她仿佛没有听见。",
  currentDocumentText: "前文里，灯火仿佛沉在水下。",
  rules: [byValue.get("仿佛")],
});
assert.equal(continuation.hits[0]?.count, 3, "续写必须同时检查已有正文与新增内容");

const protectedScan = scanWritingRepetition({
  taskKind: "new_chapter",
  generatedText: "“仿佛。”她说。仿佛是专有名词，叙述里又出现仿佛。",
  rules: [{ type: "word", value: "仿佛", maxOccurrences: 0, source: "current_instruction", exceptions: [] }],
  protectedTerms: ["仿佛是专有名词"],
});
assert.equal(protectedScan.hits[0]?.count, 1, "默认不统计对白、引用和用户要求保护的固定表达");

const local = scanWritingRepetition({
  taskKind: "local_patch",
  generatedText: "她似乎停住。",
  adjacentText: "前一段似乎已经这样写过。后一段没有。",
  rules: [{ type: "word", value: "似乎", maxOccurrences: 1, source: "creative_contract", exceptions: [] }],
});
assert.equal(local.hits[0]?.count, 2, "局部修改必须检查修改片段和相邻段落");

const batch = scanWritingBatch({
  documents: [
    { id: "chapter-1", text: "他没有回头，只是关门。" },
    { id: "chapter-2", text: "他没有解释，只是走远。" },
  ],
  rules: [{ type: "sentence_pattern", value: "他没有……只是……", maxOccurrences: 1, source: "creative_contract", exceptions: [] }],
});
assert.equal(batch.documents.length, 2);
assert.equal(batch.adjacentHits.length, 1, "批量写作必须额外检查相邻章节的重复句式");

const revisionRequest = buildWritingStyleRevisionRequest({
  draft: "雨幕仿佛一堵墙。她仿佛没有听见。远处钟声响起。",
  hits: continuation.hits,
});
assert.match(revisionRequest.prompt, /只修订以下命中句段/u);
assert.doesNotMatch(revisionRequest.prompt, /远处钟声响起/u, "局部修订请求不得携带未命中的整篇正文");

const replaced = applyWritingStyleReplacements("雨幕仿佛一堵墙。远处钟声响起。", [{
  before: "雨幕仿佛一堵墙。",
  after: "雨幕压成一堵灰墙。",
}]);
assert.equal(replaced.text, "雨幕压成一堵灰墙。远处钟声响起。");

let revisionCalls = 0;
const quality = await runWritingStyleQualityControl({
  draft: "雨幕仿佛一堵墙。她仿佛没有听见。",
  scan: (text) => scanWritingRepetition({
    taskKind: "new_chapter",
    generatedText: text,
    rules: [{ type: "word", value: "仿佛", maxOccurrences: 0, source: "creative_contract", exceptions: [] }],
  }),
  revise: async () => {
    revisionCalls += 1;
    return { replacements: [
      { before: "雨幕仿佛一堵墙。", after: "雨幕压成一堵灰墙。" },
      { before: "她仿佛没有听见。", after: "她没有回头。" },
    ] };
  },
});
assert.equal(revisionCalls, 1, "同一候选最多增加一次局部修订调用");
assert.equal(quality.scanAttempts, 2, "修订后最多复检一次");
assert.equal(quality.blocking, false);
assert.equal(quality.mayLand, true);
assert.equal(quality.remainingHits.length, 0);

const scanFailure = await runWritingStyleQualityControl({
  draft: "原始正文必须保留。",
  scan: () => { throw new Error("scanner failed"); },
  revise: async () => { throw new Error("不应调用"); },
});
assert.equal(scanFailure.text, "原始正文必须保留。");
assert.equal(scanFailure.blocking, false);
assert.equal(scanFailure.mayLand, true);
assert.match(scanFailure.notice, /质检暂时不可用/u);

const revisionFailure = await runWritingStyleQualityControl({
  draft: "仿佛仿佛。",
  scan: (text) => scanWritingRepetition({ taskKind: "new_chapter", generatedText: text, rules: [{ type: "word", value: "仿佛", maxOccurrences: 0 }] }),
  revise: async () => { throw new Error("model unavailable"); },
});
assert.equal(revisionFailure.text, "仿佛仿佛。", "修订失败必须保留初稿");
assert.equal(revisionFailure.blocking, false);
assert.equal(revisionFailure.mayLand, true);
assert.equal(revisionFailure.revisionAttempts, 1);

console.log("writing style constraints, local scan and soft quality tests passed");
