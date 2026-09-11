import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  creativeGuidanceCandidateFallbackAllowed,
  creativeGuidanceDirectRequest,
  creativeGuidanceQuestion,
  creativeGuidanceSchema,
  normalizeCreativeGuidanceState,
} from "../src/creative-guidance-contract.js";
import { creativeGuidancePersistentContractKey } from "../src/creative-guidance-persistence.js";
import { creativeGuidanceInferenceRecord } from "../src/creative-guidance-record.js";
import { creativeGuidanceDepthPrompt } from "../src/pending-decision-policy.js";

const options = [
  { id: "1", label: "保留克制的关系裂缝", preserved: "人物尊严", changed: "冲突推迟爆发", sacrificed: "即时爽感", boundary: "慢热关系线", impact: "人物更可信，后续结构需要持续蓄压" },
  { id: "2", label: "让主角当场拒绝", preserved: "主动选择", changed: "关系立即破裂", sacrificed: "暧昧余地", boundary: "需要本章强转折", impact: "剧情提速，读者获得决绝感，后续进入对抗线" },
];

assert.equal(creativeGuidanceDirectRequest("直接写"), true);
assert.equal(creativeGuidanceDirectRequest("继续写"), true);
assert.equal(creativeGuidanceDirectRequest("执行"), true);
assert.equal(creativeGuidanceDirectRequest("生成"), true);
assert.equal(creativeGuidanceDirectRequest("按这个落盘"), true);

const shortDramaSchema = creativeGuidanceSchema("short_drama_script");
assert.ok(shortDramaSchema, "短剧必须具有结构化创作引导合同");
assert.match(shortDramaSchema.clusters.map((item) => item.label).join("、"), /来源模式/u);
assert.match(shortDramaSchema.clusters.map((item) => item.label).join("、"), /制作/u);

assert.equal(creativeGuidancePersistentContractKey({ deliverableType: "novel" }), "novelCreativeContract");
assert.equal(creativeGuidancePersistentContractKey({ deliverableType: "short_drama_script", sourceMode: "original" }), "originalDramaCreativeContract");
assert.equal(creativeGuidancePersistentContractKey({ deliverableType: "short_drama_script", sourceMode: "adaptation" }), "", "改编剧本不得建立长期创作合同");
assert.equal(creativeGuidancePersistentContractKey({ deliverableType: "visual_prompt", sourceMode: "original" }), "", "提示词不得建立长期创作合同");

const structuredRecord = creativeGuidanceInferenceRecord({
  userClues: ["这是什么意思？", "刚才网络好像有点慢", "我要强冲突竖屏短剧"],
  acceptedChanges: ["模型生成的完整候选不应覆盖结构化作者决策"],
  guidanceState: {
    deliverableType: "short_drama_script",
    completedClusters: ["source-platform-format"],
    delegatedClusters: ["production-boundary"],
    decisions: [
      { cluster: "source-platform-format", value: "从零原创，竖屏，每集两分钟", source: "user" },
      { cluster: "production-boundary", value: "控制为三个主要场景", source: "delegated" },
      { cluster: "ending-payoff", value: "开放式结局", source: "inferred" },
    ],
    enhancementDiscussed: false,
  },
});
assert.match(structuredRecord, /从零原创，竖屏，每集两分钟/u);
assert.match(structuredRecord, /作者委托神思决定/u);
assert.doesNotMatch(structuredRecord, /这是什么意思|网络好像有点慢|开放式结局|完整候选/u, "正式推演记录只能消费已确认或委托的结构化决策");

const directState = normalizeCreativeGuidanceState({ deliverableType: "novel", prompt: "直接写" });
assert.equal(directState.interactionMode, "direct", "直接写不得进入选择题");
assert.equal(directState.ready, true, "直接写必须允许进入正式生成");
assert.equal(directState.candidateOptions.length, 0);

const clearDirection = normalizeCreativeGuidanceState({
  deliverableType: "novel",
  prompt: "我要写一个女儿拒绝继承家业、但不把父亲写成反派的故事。",
  value: { candidateOptions: options },
});
assert.equal(clearDirection.interactionMode, "discussion", "方向明确时不得强加候选");
assert.equal(clearDirection.candidateOptions.length, 0, "没有兜底理由时必须丢弃模型擅自给出的候选");

assert.equal(creativeGuidanceCandidateFallbackAllowed({ prompt: "我没想法" }), true);
assert.equal(creativeGuidanceCandidateFallbackAllowed({ prompt: "给我三个方案比较" }), true);
assert.equal(creativeGuidanceCandidateFallbackAllowed({ prompt: "方向已经明确" }), false);

const fallbackState = normalizeCreativeGuidanceState({
  deliverableType: "novel",
  prompt: "我没想法",
  value: {
    candidateOptions: options,
    choiceFallbackReason: "",
    pendingReflectionQuestion: "哪个方向最像你的判断？为什么？",
    recommendation: "推荐方案 2，因为它把人物选择放到台前。",
    tradeoffs: ["即时冲突与关系余味之间的取舍"],
  },
});
assert.equal(fallbackState.interactionMode, "choice_fallback");
assert.equal(fallbackState.decisionStatus, "tentative");
assert.equal(fallbackState.candidateOptions.length, 2);
assert.equal(fallbackState.recommendation.includes("方案 2"), true);

const candidateReply = creativeGuidanceQuestion({
  state: fallbackState,
  proposedQuestion: "方向 1 保留关系余味；方向 2 让主角当场拒绝。请选择 1 或 2？",
});
assert.match(candidateReply, /哪个方向最像你的判断，为什么？$/u, "候选回复必须以开放式意见问题结束");
assert.doesNotMatch(candidateReply, /请选择 1 或 2？$/u, "候选回复不能以机械编号选择收尾");
assert.equal((candidateReply.match(/[？?]/gu) ?? []).length, 1, "每轮只能保留一个最高价值问题");
for (const field of ["保留：", "改变：", "牺牲：", "适用边界：", "影响：", "专业推荐："]) {
  assert.match(candidateReply, new RegExp(field), `候选讨论必须包含 ${field}`);
}

const questionnaireState = normalizeCreativeGuidanceState({
  deliverableType: "novel",
  value: { questionCluster: "genre-platform-audience" },
});
const questionnaireReply = creativeGuidanceQuestion({
  state: questionnaireState,
  proposedQuestion: `### 1. 故事类型
A. 现代豪门
B. 都市婚恋

### 2. 核心虐点
A. 追妻火葬场
B. 替身与白月光

### 3. 结局
A. HE
B. BE

请直接回复编号即可。`,
});
assert.equal(questionnaireReply, creativeGuidanceSchema("novel").clusters[0].question, "多标题、多组选项问卷必须回退到当前唯一决策簇");
assert.doesNotMatch(questionnaireReply, /核心虐点|###|A\.|B\./u, "引导正文不得携带 Markdown 伪选择题");

const focusedQuestion = "你更希望先确定连载平台，还是先说你心里的目标读者？";
assert.equal(creativeGuidanceQuestion({ state: questionnaireState, proposedQuestion: focusedQuestion }), focusedQuestion, "真正的单步开放问题应保留模型的自然表达");

const selectedState = normalizeCreativeGuidanceState({
  deliverableType: "novel",
  prompt: "2",
  previousState: fallbackState,
  value: { completedClusters: [fallbackState.questionCluster], selectedCandidate: "2" },
});
assert.equal(selectedState.selectedCandidate, "2");
assert.equal(selectedState.decisionStatus, "confirmed", "点选必须等同输入同一答案，不得附加暂定权限状态");
assert.equal(selectedState.interactionMode, "discussion");
assert.equal(selectedState.completedClusters.includes(fallbackState.questionCluster), true, "选项文字足够回答时应正常完成当前决策簇");
assert.equal(selectedState.ready, false, "完成一个决策簇不代表直接写入，后续仍按普通对话判断");
assert.doesNotMatch(creativeGuidanceQuestion({ state: selectedState }), /为什么认可|最像你的判断/u, "选择后不得机械追问理由");

const confirmationWithoutOpinion = normalizeCreativeGuidanceState({
  deliverableType: "novel",
  prompt: "确认",
  previousState: selectedState,
  value: { completedClusters: [selectedState.questionCluster] },
});
assert.equal(confirmationWithoutOpinion.decisionStatus, "confirmed", "后续自然语言按普通答案处理");

const confirmedState = normalizeCreativeGuidanceState({
  deliverableType: "novel",
  prompt: "我选2，因为主角必须亲自拒绝，不能把关键决定交给外部事故。",
  previousState: selectedState,
});
assert.equal(confirmedState.decisionStatus, "confirmed");
assert.equal(confirmedState.completedClusters.includes(selectedState.questionCluster), true, "说明理由后才可完成当前决策");
assert.match(confirmedState.userOpinion, /主角必须亲自拒绝/u);
assert.notEqual(confirmedState.questionCluster, selectedState.questionCluster, "已完成的问题不得重复询问");

const delegatedState = normalizeCreativeGuidanceState({
  deliverableType: "novel",
  prompt: "按你的专业判断执行",
  previousState: selectedState,
});
assert.equal(delegatedState.interactionMode, "direct");
assert.equal(delegatedState.decisionStatus, "delegated");
assert.equal(delegatedState.ready, true, "明确授权专业判断后不得继续阻塞");

let repeatedState = normalizeCreativeGuidanceState({ deliverableType: "novel" });
repeatedState = normalizeCreativeGuidanceState({ deliverableType: "novel", prompt: "什么意思", previousState: repeatedState });
repeatedState = normalizeCreativeGuidanceState({ deliverableType: "novel", prompt: "还是不明白", previousState: repeatedState });
assert.equal(repeatedState.questionRound, 2, "同一问题的追问次数必须封顶为两轮");
assert.match(creativeGuidanceQuestion({ state: repeatedState }), /不重复原问题/u, "达到上限后不得原样重复问题");

const depthPrompt = creativeGuidanceDepthPrompt();
assert.match(depthPrompt, /先复述作者真正想达到的效果/u);
assert.match(depthPrompt, /点击选项等同作者输入/u);
assert.match(depthPrompt, /笔记中创建小说不套用作品模式的分卷结构/u);

const [orchestrator, guidanceDoc, moduleDoc, ruleDoc, appSource] = await Promise.all([
  readFile(new URL("../src/server/shensi-orchestrator.mjs", import.meta.url), "utf8"),
  readFile(new URL("../packaging/bundled/skill/神思/小说写作技能skill/创作引导.md", import.meta.url), "utf8"),
  readFile(new URL("../packaging/bundled/skill/神思/神思模块/创作引导模块.md", import.meta.url), "utf8"),
  readFile(new URL("../packaging/bundled/skill/神思/神思模块/规则模块/神思-创作引导双启动规则.md", import.meta.url), "utf8"),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
]);
for (const source of [orchestrator, guidanceDoc, moduleDoc, ruleDoc]) {
  assert.match(source, /讨论优先|interactionMode=discussion/u, "运行提示和分发规则必须落实讨论优先");
  assert.match(source, /点击.*等同|选项.*普通用户文本/u, "选择必须等同普通用户文字输入");
}
assert.match(orchestrator, /笔记中创建小说不得套用作品模式分卷/u);
assert.match(appSource, /persistentCreativeGuidanceContract\(/u, "后续写作上下文必须通过来源模式边界读取长期合同");
assert.match(appSource, /creativeGuidanceChoiceContinuation\([\s\S]{0,700}sendMessage\(conversationChoiceUserInstruction\(/u,
  "创作引导选择必须作为普通用户文字继续同一 Agent 对话");
assert.match(appSource, /messages: taskMessages\.filter\([\s\S]{0,320}message\.id === sourceMessageId/u,
  "统一 Agent 必须接收包含引导回答在内的持久化会话消息");
assert.match(appSource, /guidanceState:\s*candidateTarget\?\.guidanceState/u, "正式推演记录必须消费本轮结构化引导状态");

console.log("creative guidance discussion-first tests passed");
