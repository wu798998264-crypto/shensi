import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createConversationChoiceState,
  selectConversationChoice,
  candidateGenerationRequest,
  conversationChoiceOverrideFromInstruction,
  supersedeConversationChoiceInstructions,
  conversationChoiceUserInstruction,
  structuredCreativeGuidanceChoice,
} from "../src/conversation-choice-panel.js";
import { conversationMessageEligibleForModel } from "../src/conversation-context.js";

let state = createConversationChoiceState({ prompt: "请给我多候选稿" });
assert.equal(state.step, "writer_mode");
state = selectConversationChoice(state, { type: "writer_mode", value: "single" });
assert.equal(state.step, "direction");
state = selectConversationChoice(state, { type: "direction", value: "emotion" });
assert.equal(state.step, "candidate_count");
state = selectConversationChoice(state, { type: "candidate_count", value: 3 });
assert.equal(state.step, "confirm");
assert.equal(candidateGenerationRequest(state).count, 3);
assert.equal(candidateGenerationRequest(state).direction, "emotion");

let multi = createConversationChoiceState({
  prompt: "多主笔生成候选",
  writers: [{ id: "builtin:novel-writer", name: "小说正文主笔" }, { id: "builtin:chinese-novelist-skill", name: "小说原型设计" }],
});
multi = selectConversationChoice(multi, { type: "writer_mode", value: "multiple" });
assert.equal(multi.step, "writers");
multi = selectConversationChoice(multi, { type: "writers", value: ["builtin:novel-writer", "builtin:chinese-novelist-skill"] });
assert.equal(multi.step, "writer_counts");
multi = selectConversationChoice(multi, { type: "writer_counts", value: { "builtin:novel-writer": 2, "builtin:chinese-novelist-skill": 3 } });
assert.equal(multi.step, "confirm");
assert.deepEqual(candidateGenerationRequest(multi).countsByWriter, { "builtin:novel-writer": 2, "builtin:chinese-novelist-skill": 3 });

assert.deepEqual(conversationChoiceOverrideFromInstruction("不用之前的 2 份，改为 3 份候选稿"), { candidateCount: 3 });
const supersededChoices = supersedeConversationChoiceInstructions([
  { id: "choice-2", role: "user", content: "生成 2 份候选稿", contextEligible: true, conversationChoiceInstruction: true },
  { id: "reply", role: "assistant", content: "好的", contextEligible: true },
], "改为 3 份");
assert.equal(supersededChoices[0].choiceSuperseded, true, "最新自然语言数量必须使旧选项失效");
assert.equal(conversationMessageEligibleForModel(supersededChoices[0]), false, "已失效选项不得继续进入模型上下文");
assert.equal(conversationMessageEligibleForModel({ role: "user", content: "改为 3 份", contextEligible: true }), true);
assert.equal(conversationChoiceUserInstruction({ label: "科幻" }), "科幻", "点选内容必须等同于用户直接输入同一文本");
assert.equal(conversationChoiceUserInstruction({ label: "", value: "从零开始" }), "从零开始");

const guidanceOptions = [
  { id: "1", label: "现代都市" },
  { id: "2", label: "古代背景" },
  { id: "3", label: "仙侠幻想" },
];
assert.equal(structuredCreativeGuidanceChoice({ guidanceState: { interactionMode: "discussion", candidateOptions: guidanceOptions } }), null,
  "普通讨论模式不得因为正文包含选项而弹出选择卡");
assert.equal(structuredCreativeGuidanceChoice({ guidanceState: { interactionMode: "choice_fallback", candidateOptions: [guidanceOptions[0]] } }), null,
  "候选不足两个时不得显示无效选择卡");
assert.deepEqual(structuredCreativeGuidanceChoice({
  guidanceState: {
    interactionMode: "choice_fallback",
    pendingReflectionQuestion: "哪个方向更接近你的想法？",
    candidateOptions: guidanceOptions,
  },
}), { question: "哪个方向更接近你的想法？", options: guidanceOptions }, "确认需要有限选择时必须返回结构化原生选择卡");

const [app, styles] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);
assert.match(app, /conversationChoicePanel/u, "选项必须作为对话内面板存在");
assert.match(app, /data-conversation-choice/u, "对话内选项必须使用统一事件标记");
assert.doesNotMatch(app, /value="writers" disabled/u, "备用主笔可用后不得硬编码禁用多主笔");
assert.doesNotMatch(app, /id="candidateGenerationDialog"/u, "候选配置不应再使用独立弹窗");
assert.match(app, /conversationChoiceInstruction: true/u, "点选结果必须显示为用户选项指令");
assert.match(app, /conversationChoiceQuestion: true/u, "神思提出的选项问题必须保留在对话记录中");
assert.match(app, /const appendPendingConversationTaskInstruction =/u,
  "发送后需要先确认的任务必须有统一的原指令入区入口");
assert.doesNotMatch(app, /if \(workspaceBindingRequired &&/u, "不得在 Agent 理解前通过关键词判断是否需要工作区");
assert.match(app, /taskMessages\.push\(userMessage\)[\s\S]{0,2000}await onPersist\(\)[\s\S]{0,500}yieldAfterImmediateInstructionRender/u, "用户消息先持久化和显示，再启动 Agent");
const continuationChoiceStart = app.indexOf("const openContinuationDestinationChoice =");
const continuationChoiceEnd = app.indexOf("const openLandingResolutionChoice", continuationChoiceStart);
const continuationChoiceOpen = app.slice(continuationChoiceStart, continuationChoiceEnd);
assert.match(continuationChoiceOpen, /appendPendingConversationTaskInstruction\(\{[\s\S]{0,500}pendingConversationChoice =/u,
  "续写目标选择必须发生在原始用户指令入区之后");
const continuationHandlerStart = app.indexOf('if (pendingConversationChoice.kind === "continuation_destination"');
const continuationHandlerEnd = app.indexOf('if (pendingConversationChoice.kind === "image_prompt_intent"', continuationHandlerStart);
const continuationHandler = app.slice(continuationHandlerStart, continuationHandlerEnd);
assert.match(continuationHandler, /displayContent:\s*clarified/u,
  "选择续写目标后只能新增所选补充，不得把原指令重复显示一次");
assert.match(continuationHandler, /taskContextSnapshot:\s*pending\.taskContextSnapshot/u,
  "续写目标选择必须沿用首次发送时锁定的任务和文档位置");
assert.match(app, /event\.type === "question"[\s\S]{0,1100}await persistNativeConversation\(runtime\)[\s\S]{0,200}await yieldAfterImmediateInstructionRender/u, "动态问题先保存显示，之后呈现选项");
assert.match(app, /kind:\s*"media_connection"/u, "图片和视频配置选择必须接入统一对话选择卡");
assert.match(app, /data-choice-type="media_connection_profile"|type:\s*"media_connection_profile"/u, "媒体选择卡必须先选择具体配置");
assert.match(app, /type:\s*"media_connection_model"/u, "媒体选择卡必须支持按配置继续选择模型");
assert.match(app, /type:\s*"media_video_aspect"/u, "视频选择卡必须支持比例选择");
assert.match(app, /type:\s*"media_video_resolution"/u, "视频选择卡必须支持清晰度选择");
assert.match(app, /type:\s*"media_video_duration"/u, "视频选择卡必须支持每次选择时长");
assert.match(app, /requireVideoDuration:\s*true/u, "视频生成必须每次要求选择时长");
assert.match(app, /视频时长不会保存为默认值/u, "视频时长不能写入默认配置");
assert.match(app, /conversationMediaDefaultIntent/u, "对话必须支持自然语言设置媒体默认参数");
assert.match(app, /mediaGenerationDefaults/u, "媒体默认参数必须按对话持久化");
assert.match(app, /conversation-choice-parameter-group[\s\S]{0,180}data-parameter-group="quality"/u, "图片质量必须作为独立参数分区显示");
assert.doesNotMatch(app, /label:\s*"返回模型"|label:\s*"返回配置"/u, "媒体选择步骤必须统一显示返回上一步");
assert.match(app, /label:\s*"返回上一步"/u, "媒体选择步骤必须保留统一的返回入口");
assert.match(styles, /media_image_parameters_confirm"\]:disabled[\s\S]{0,320}pointer-events: none[\s\S]{0,160}transition: none/u,
  "参数未选全时确认按钮必须稳定保持灰色且不响应交互动效");
assert.doesNotMatch(app, /conversation-media-connection-dialog/u, "对话媒体配置不得继续使用中央弹窗");
const mediaGenerationStart = app.indexOf("const generateMediaFromComposer");
assert.ok(mediaGenerationStart > 0, "媒体生成入口必须保留");
assert.match(app.slice(mediaGenerationStart, mediaGenerationStart + 10_000), /persistWorkspaceStateOnly\(\{ saveDelay: 180 \}\)/u, "媒体参数准备状态不得伪装成文档写入");
assert.doesNotMatch(app, /我暂时倾向/u, "选项不得被偷偷改写成暂定倾向或附加特殊权限");
assert.equal(conversationMessageEligibleForModel({
  role: "user",
  content: "单主笔生成多稿",
  contextEligible: true,
  conversationChoiceInstruction: true,
}), true, "点选内容必须作为普通用户上下文供后续自然语言覆盖");
assert.doesNotMatch(app, /queueMicrotask\(\(\) => openCandidateComparison\(group\.id\)\)/u, "多候选生成后必须等待用户点击查看，不得自动弹出预览窗口");
assert.match(app, /data-view-candidate-branches[^>]*>查看候选稿<\/button>/u, "候选消息必须提供打开原版候选预览窗口的明确入口");
assert.match(app, /event\.type === "open_candidates"[\s\S]{0,280}openLatestCandidateComparison/u, "Agent 根据语义请求打开当前候选预览，不用关键词分支");
assert.match(app, /data-adopt-candidate-branch/u, "候选对比窗口必须提供独立采用入口");
const switchStart = app.indexOf("const switchCandidateDraftBranch");
const adoptStart = app.indexOf("const adoptCandidateDraftBranch", switchStart);
assert.ok(switchStart > 0 && adoptStart > switchStart, "候选切换和采用必须是两个独立动作");
assert.doesNotMatch(app.slice(switchStart, adoptStart), /synchronizeSelectedCandidateAttempt/u, "左右切换候选不得自动写入");
assert.match(app.slice(adoptStart, adoptStart + 1800), /synchronizeSelectedCandidateAttempt/u, "点击采用必须进入安全写入事务");

console.log("conversation choice flow regressions passed");
