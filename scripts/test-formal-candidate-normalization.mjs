import assert from "node:assert/strict";
import { appendModelTextEvent, normalizeSingleCandidateOutput } from "../src/formal-candidate-normalization.js";
import { scanInternalArtifactLeakage } from "../src/content-guard.js";
import { candidateDocumentTargetPolicy } from "../src/candidate-chapters.js";

const chapter = `第4章 洛字为警

林风在耳边呼啸。牧尘沿着山路疾掠而下。

“……洛。”

石碑深处浮现的字，此刻仿佛在颤抖。

章节任务：信息调查与情绪压力升级
叙事模式：外部行动串联内心
结束功能：引出下一章
关键保护元素：玉简与北苍
近期风险：避免重复节奏。`;
const repeated = `${chapter}\n\\</think>---\n\n${chapter}\n\\</think>---\n\n${chapter}`;
const normalized = normalizeSingleCandidateOutput(repeated);
assert.equal(normalized.invalidReason, "");
assert.equal(normalized.duplicateCount, 2);
assert.equal(normalized.text, `第4章 洛字为警\n\n林风在耳边呼啸。牧尘沿着山路疾掠而下。\n\n“……洛。”\n\n石碑深处浮现的字，此刻仿佛在颤抖。`);
assert.doesNotMatch(normalized.text, /think|章节任务|关键保护元素/u);

const completeThinking = normalizeSingleCandidateOutput(`<think>这里是内部推理。</think>\n第5章 北苍\n\n少年抬头望向山门。`);
assert.equal(completeThinking.text, "第5章 北苍\n\n少年抬头望向山门。");

const conflicting = normalizeSingleCandidateOutput(`第6章 初见\n\n第一种写法。\n\\</think>\n第6章 初见\n\n第二种写法。`);
assert.match(conflicting.invalidReason, /多个不同正文结果/u);
assert.equal(conflicting.text, "");
assert.equal(conflicting.variants.length, 2);

const chapterBatch = normalizeSingleCandidateOutput(`第7章 启程\n\n第一章内容。\n\n第8章 入城\n\n第二章内容。`);
assert.equal(chapterBatch.invalidReason, "", "不同章节不得被误判为多个候选版本");
assert.match(chapterBatch.text, /第7章 启程[\s\S]*第8章 入城/u);
assert.equal(normalizeSingleCandidateOutput("【正式内容】\n第9章 归途\n\n风雪渐止。").text, "第9章 归途\n\n风雪渐止。");

let eventState = appendModelTextEvent({ currentText: "", eventText: "第一段" });
assert.equal(eventState.text, "第一段");
eventState = appendModelTextEvent({ currentText: eventState.text, previousEventText: eventState.eventText, eventText: "第一段第二段" });
assert.equal(eventState.delta, "第二段", "同一 part 的完整快照只能追加新增后缀");
assert.equal(eventState.text, "第一段第二段");
eventState = appendModelTextEvent({ currentText: eventState.text, previousEventText: eventState.eventText, eventText: "第一段第二段" });
assert.equal(eventState.delta, "", "重复快照不得再次追加");
assert.equal(eventState.text, "第一段第二段");
const repeatedShortDelta = appendModelTextEvent({ currentText: "哈", eventText: "哈" });
assert.equal(repeatedShortDelta.text, "哈哈", "没有稳定 part 身份的短增量重复可能是有效正文，不得误删");
const longSnapshot = "这是一次完整文本快照。".repeat(8);
assert.equal(appendModelTextEvent({ currentText: longSnapshot, eventText: longSnapshot }).delta, "", "跨 part 重复返回的完整长文本必须幂等去重");

const leakage = scanInternalArtifactLeakage("正文。\\</think>");
assert.equal(leakage.pass, false);
assert.ok(leakage.violations.some((item) => item.id === "internal-thinking-tag"));
const briefLeakage = scanInternalArtifactLeakage("正文。\n章节任务：信息调查");
assert.equal(briefLeakage.pass, false);
assert.ok(briefLeakage.violations.some((item) => item.id === "internal-chapter-brief"));

const singleTargetPolicy = candidateDocumentTargetPolicy({
  fallbackTarget: { documentId: "chapter-4", kind: "chapter-batch", chapterDocuments: [{ target: { documentId: "chapter-4" } }] },
  writeAuthorization: { state: "commit", targetDocumentIds: ["note-locked"] },
  taskContract: { deliverables: [{ id: "deliverable-1", targetDocumentId: "note-locked", target: { documentId: "note-locked", moduleId: "manuscript" } }] },
});
assert.equal(singleTargetPolicy.mode, "single");
assert.equal(singleTargetPolicy.target.documentId, "note-locked", "模型章节标题不得覆盖唯一授权目标");

const batchTargetPolicy = candidateDocumentTargetPolicy({
  fallbackTarget: { documentId: "chapter-4" },
  writeAuthorization: { state: "commit", targetDocumentIds: ["chapter-4", "chapter-5"] },
  taskContract: { deliverables: [{ targetDocumentId: "chapter-4" }, { targetDocumentId: "chapter-5" }] },
});
assert.equal(batchTargetPolicy.mode, "split", "明确多文档合同仍须保留批量拆分");

console.log("formal candidate normalization regressions passed");
