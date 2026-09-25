import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  conversationCanAcceptSupplement,
  conversationCompletionStatus,
  conversationImmediateInstructionBlocksDispatch,
  conversationTaskIsRunning,
  conversationTaskMessageIsRunning,
  dequeueReadyConversationInstruction,
  repairConversationTaskMessages,
} from "../src/conversation-task-queue.js";
import { createConversationMediaDispatchContract } from "../src/conversation-media-dispatch.js";
import { conversationImagePromptKind } from "../src/conversation-media-prompt-intent.js";
import { conversationImageRepeatRequest, explicitConversationImageAspectRatio, explicitConversationImageQuality, mergeConversationImageRepeatParameters, requestedConversationImageOptions } from "../src/conversation-image-settings.js";
import { agentTaskRouteFromDelivery, agentTaskWritePresentation } from "../src/conversation-agent-task-route.js";

const unresolvedWrite = agentTaskWritePresentation({
  pending: true,
  execution: { taskRoute: { intentEnvelope: { taskType: "modification", writeMode: "conversation_only" } } },
});
assert.equal(unresolvedWrite.resolved, false, "运行早期只有不可靠的意图猜测时不得显示“不写入”");
const writingNow = agentTaskWritePresentation({
  pending: true,
  execution: { taskRoute: { deliveryMode: "documents", intentEnvelope: { taskType: "modification", writeMode: "conversation_only" } } },
});
assert.equal(writingNow.resolved, true);
assert.equal(writingNow.mode, "formal_auto", "documents.write 一旦开始必须覆盖早期错误的“不写入”展示");
const written = agentTaskWritePresentation({
  pending: false,
  execution: {
    taskRoute: { intentEnvelope: { taskType: "modification", writeMode: "conversation_only" } },
    agentResultReferences: [{ type: "document_saved", documentId: "doc-1", trustedDocumentSave: true }],
  },
});
assert.equal(written.mode, "formal_auto");
assert.deepEqual(written.targetDocumentIds, ["doc-1"], "可信写入回执必须成为任务卡最终写入状态和目标证据");
const deliveredConversation = agentTaskRouteFromDelivery({ mode: "conversation", taskType: "general_qa", documentIds: [] }, {});
assert.equal(deliveredConversation.deliveryMode, "conversation");
assert.equal(agentTaskWritePresentation({ pending: true, execution: { taskRoute: deliveredConversation } }).mode, "conversation_only", "明确对话交付后才显示不写入");

const running = [{ role: "assistant", pending: true, execution: { status: "running" } }];
const acceptedInstructions = [
  { id: "accepted-first", conversationId: "conversation-1" },
  { id: "accepted-second", conversationId: "conversation-1" },
  { id: "other-conversation", conversationId: "conversation-2" },
];
assert.equal(conversationImmediateInstructionBlocksDispatch({
  conversationId: "conversation-1",
  instructions: acceptedInstructions,
  instructionId: "accepted-first",
}), false, "最早接收的消息必须保留首次执行权");
assert.equal(conversationImmediateInstructionBlocksDispatch({
  conversationId: "conversation-1",
  instructions: acceptedInstructions,
  instructionId: "accepted-second",
}), true, "后接收的消息必须等待前一条进入运行态");
assert.equal(conversationImmediateInstructionBlocksDispatch({
  conversationId: "conversation-1",
  instructions: acceptedInstructions,
}), true, "队列排空器不得越过仍在准备的即时消息");
assert.equal(conversationImmediateInstructionBlocksDispatch({
  conversationId: "conversation-3",
  instructions: acceptedInstructions,
}), false, "不同对话的即时消息不得互相阻塞");
const completedButStale = [{ role: "assistant", pending: true, execution: { status: "complete" } }];
const returnedButProviderStillRunning = [{ role: "assistant", pending: false, execution: { status: "running", endedAt: 100 } }];
assert.equal(conversationTaskIsRunning(running), true);
assert.equal(conversationTaskIsRunning(completedButStale), false, "terminal status must override a stale pending flag");
assert.equal(conversationTaskIsRunning(returnedButProviderStillRunning), false, "a reply with endedAt must not retain a stale provider running state");
assert.equal(conversationTaskMessageIsRunning({ role: "assistant", pending: true, execution: { status: "waiting_input" } }), false, "a task waiting for an explicit user choice must release the instruction queue");
assert.equal(conversationCompletionStatus("running"), "complete", "a returned response must not persist an intermediate provider status");
assert.equal(conversationCompletionStatus("retry_required"), "retry_required", "a real terminal attention state must be retained");
const supersededRunning = [
  { role: "assistant", pending: true, execution: { status: "running", requestId: "request-1" } },
  { role: "assistant", pending: false, execution: { status: "complete", requestId: "request-1" } },
];
assert.equal(conversationTaskIsRunning(supersededRunning), false, "a later terminal reply for the same durable task must release the queue");
assert.equal(repairConversationTaskMessages(supersededRunning), 1, "persisted stale placeholders must be repaired during workspace hydration");
assert.equal(supersededRunning[0].pending, false);
const endedRunning = [{ role: "assistant", pending: true, execution: { status: "running", endedAt: 100 } }];
assert.equal(repairConversationTaskMessages(endedRunning), 1);
assert.equal(endedRunning[0].execution.status, "complete", "a returned intermediate provider status must be normalized when repairing old state");
const staleRunningRetryRequired = [{ role: "assistant", pending: true, execution: { status: "running", mediaJobStatus: "retry_required" } }];
assert.equal(conversationTaskMessageIsRunning(staleRunningRetryRequired[0]), false, "a terminal media status must override a stale generic running status");
assert.equal(repairConversationTaskMessages(staleRunningRetryRequired), 1, "mixed running and terminal media states must be repaired during hydration");
assert.equal(staleRunningRetryRequired[0].pending, false);
assert.equal(staleRunningRetryRequired[0].execution.status, "retry_required", "the durable attention state must be retained");
const releasedQueue = { queue: [{ id: "next-after-completion", state: "queued", content: "继续修改剧情" }] };
const releasedItem = dequeueReadyConversationInstruction({
  conversation: releasedQueue,
  messages: returnedButProviderStillRunning,
  leaseId: "lease-after-completion",
});
assert.equal(releasedItem?.id, "next-after-completion", "the next instruction must dispatch immediately after a returned task records its end time");
assert.equal(conversationCanAcceptSupplement({ messages: running }), true);
assert.equal(conversationCanAcceptSupplement({ messages: completedButStale }), false, "completed task must not capture a new supplement");
assert.equal(conversationCanAcceptSupplement({ messages: supersededRunning }), false, "a superseded stale placeholder must not capture a new instruction as a supplement");
assert.equal(conversationCanAcceptSupplement({ messages: [{ role: "assistant", pending: true, execution: { status: "cancel_requested" } }] }), false, "a task already being cancelled must not capture new supplements");
assert.equal(conversationCanAcceptSupplement({
  messages: completedButStale,
  preparations: [{ sourceMessageId: "old", pendingMessageId: "done", cancelled: false }],
  preparingSourceMessageIds: new Set(),
  immediateInstructionActive: false,
}), false, "stale preparation registry entry must not keep supplement mode alive");
assert.equal(conversationCanAcceptSupplement({
  preparations: [{ sourceMessageId: "new", pendingMessageId: "", cancelled: false }],
  preparingSourceMessageIds: new Set(["new"]),
}), true, "a real preparation before the assistant placeholder exists remains supplementable");

const visualPrompt = [
  "唐芊儿",
  "- 身份：北灵院女学员",
  "- 外貌：少女模样，柳眉，俏脸",
  "- 服饰：浅色修真女裙，袖口垂低",
  "- 构图：人物位于画面中央",
  "- 光照：柔和侧逆光",
  "- 镜头运动约束：静态图片资产，无运镜要求",
].join("\n");
assert.equal(conversationImagePromptKind(visualPrompt), "text", "只有视觉描述或成品提示词不得触发付费图片选择");
assert.equal(conversationImagePromptKind("电影感侧逆光，少女站在城门前"), "text");
assert.equal(conversationImagePromptKind("男士牧尘图片"), "text", "只提到图片但没有明确执行动词时必须按文字请求处理");
assert.equal(conversationImagePromptKind("图片在哪？"), "text", "图片追问不得误触发新的付费生成选择");
assert.equal(conversationImagePromptKind("刚才的图片呢？"), "text", "指代上一张图片的追问不得创建新的生成任务");
assert.equal(conversationImagePromptKind("请优化这段图片提示词，让它更简洁"), "prompt_edit");
assert.equal(conversationImagePromptKind("为什么图片生成失败？请分析原因"), "text");
assert.equal(conversationImagePromptKind("续写小说第三章，保持人物关系不变"), "text");
assert.equal(conversationImagePromptKind("请生成一张冷峻男主角图片"), "explicit_image");

const textOnlyMediaRequests = [
  "总结刚才图片生成的结果",
  "比较生成图片的效果",
  "评价刚才生成的图片",
  "复制生成图片",
  "移动生成图片",
  "删除生成图片",
  "说明生成图片的工作原理",
  "列出图片生成参数",
  "告诉我生成图片用了哪个模型",
  "查看生成视频用了多少时间",
  "如果要生成图片应该选什么模型",
  "等我确认后再生成图片",
  "稍后生成图片",
  "不要生成视频，只写提示词",
  "先不生成视频，分析失败原因",
  "停止生成视频并说明原因",
  "请问你支持生成图片吗",
  "可以生成视频吗",
  "设计一个封面",
  "做个封面",
  "修改这张图片",
  "从视频提取关键帧",
  "提取提示词",
  "把这段内容转化为图片提示词",
  "写一段视频提示词",
  "图片已经生成成功了",
  "正在生成图片，不要重复执行",
  "生成完成的图片在哪里",
  "视频已经生成完成",
  "视频正在生成中",
  "生成图片中",
  "制定一个生成图片的计划",
  "准备生成一张图片，先告诉我参数",
  "把文档重新生成",
  "这并非让我生成图片",
];
for (const instruction of textOnlyMediaRequests) {
  assert.equal(createConversationMediaDispatchContract({ text: instruction }), null, `非媒体成品任务不得弹选择框：${instruction}`);
}

const explicitImageRequests = [
  "能不能帮我生成一张图片",
  "给我一张白猫图片",
  "我要一张白猫图片",
  "画一张古风人物图",
  "测试图片生成能力，生成一张红色方块图",
  "直接生成一张封面图",
  "出一张封面成品图",
  "请分别生成三张图片",
  "生成一张图",
  "把这段提示词转换成一张图片",
  "重绘这张图片",
  "把这张图片重新生成",
];
for (const instruction of explicitImageRequests) {
  assert.equal(createConversationMediaDispatchContract({ text: instruction })?.channel, "image", `明确图片成品任务必须进入图片生成：${instruction}`);
}

const explicitVideoRequests = [
  "能不能帮我生成一段视频",
  "给我一个雨夜追逐视频",
  "我要一段角色登场短片",
  "把这张图片变成视频",
  "根据这段分镜生成视频",
  "把视频脚本制作成视频",
];
for (const instruction of explicitVideoRequests) {
  assert.equal(createConversationMediaDispatchContract({ text: instruction })?.channel, "video", `明确视频成品任务必须进入视频生成：${instruction}`);
}

const compositeRoute = createConversationMediaDispatchContract({ text: "生成一张白猫图片并总结画面构图" });
assert.equal(compositeRoute?.kind, "composite", "明确的复合任务必须逐句判定");
assert.deepEqual(compositeRoute?.steps.map((step) => step.kind), ["image", "text"]);
assert.equal(createConversationMediaDispatchContract({ text: "不要生成图片，生成一段白猫奔跑视频" })?.channel, "video", "否定片段不得污染同一条消息中的明确视频任务");
const analyzeThenVideo = createConversationMediaDispatchContract({ text: "分析这张图片，然后生成一段运镜视频" });
assert.equal(analyzeThenVideo?.kind, "composite", "媒体分析与真实生成并存时必须保留文字步骤");
assert.deepEqual(analyzeThenVideo?.steps.map((step) => step.kind), ["text", "video"]);
const genericImageComposite = createConversationMediaDispatchContract({ text: "生成一张图并说明它的构图" });
assert.equal(genericImageComposite?.kind, "composite", "简写图片请求也必须参与复合任务拆分");
assert.deepEqual(genericImageComposite?.steps.map((step) => step.kind), ["image", "text"]);

assert.equal(createConversationMediaDispatchContract({ text: visualPrompt }), null, "视觉提示词本身不得自动进入图片生成链");
assert.equal(createConversationMediaDispatchContract({ text: "请分析这张图片的构图" }), null, "图片分析不得弹出生成参数");
assert.equal(createConversationMediaDispatchContract({ text: "请生成一张冷峻男主角图片" })?.channel, "image");

const recoveryImage = createConversationMediaDispatchContract({ text: "刚才男士图片实际没有成功返回附件，现在重新生成" });
assert.equal(recoveryImage?.channel, "image", "明确要求重新生成缺失图片时必须直接进入真实图片链");

const lockedImage = createConversationMediaDispatchContract({
  text: visualPrompt,
  channel: "image",
  profileId: "aggregate-image-profile",
});
assert.equal(lockedImage?.channel, "image");
assert.equal(lockedImage?.profileId, "aggregate-image-profile", "submission must retain the selected image profile");
const lockedModel = createConversationMediaDispatchContract({
  text: visualPrompt,
  channel: "image",
  profileId: "dreamina-guobazai",
  model: "dreamina-image-3.1",
});
const lockedImageParameters = createConversationMediaDispatchContract({
  text: visualPrompt,
  channel: "image",
  profileId: "dreamina-guobazai",
  model: "dreamina-image-3.1",
  aspectRatio: "16:9",
  quality: "2k",
  reuseLastSuccessfulParameters: true,
});
assert.equal(lockedImageParameters?.aspectRatio, "16:9");
assert.equal(lockedImageParameters?.quality, "2k");
assert.equal(lockedImageParameters?.reuseLastSuccessfulParameters, true);
assert.equal(explicitConversationImageAspectRatio("请生成 9:16 竖屏图片"), "9:16");
assert.equal(explicitConversationImageQuality("请使用高清质量"), "high");
assert.equal(conversationImageRepeatRequest("再来一张"), true);
assert.deepEqual(mergeConversationImageRepeatParameters({
  remembered: { aspectRatio: "16:9", quality: "high" },
  prompt: "改成 9:16 再来一张",
}), { aspectRatio: "9:16", quality: "high" });
assert.deepEqual(mergeConversationImageRepeatParameters({
  remembered: { aspectRatio: "16:9", quality: "high" },
  prompt: "改成 2K 再来一张",
}), { aspectRatio: "16:9", quality: "2k" });
assert.deepEqual(mergeConversationImageRepeatParameters({
  remembered: { aspectRatio: "4:3", quality: "standard" },
  prompt: "比例改为 3:4，再生成一张图片",
}), { aspectRatio: "3:4", quality: "standard" }, "只修改比例时必须逐项覆盖，质量继续沿用");
assert.deepEqual(mergeConversationImageRepeatParameters({
  remembered: { aspectRatio: "9:16", quality: "2k" },
  prompt: "质量改成高清，再来一张",
}), { aspectRatio: "9:16", quality: "high" }, "只修改质量时必须逐项覆盖，比例继续沿用");
assert.deepEqual(requestedConversationImageOptions({
  prompt: "生成 4:3 的 2K 图片",
  supportedAspectRatios: ["1:1", "4:3"],
  supportedQualities: ["1k", "2k"],
}), {
  aspectRatio: "4:3",
  quality: "2k",
  explicitAspectRatio: "4:3",
  explicitQuality: "2k",
});
assert.equal(lockedModel?.model, "dreamina-image-3.1", "submission must retain the selected model inside the selected profile");

const app = await readFile("src/app.js", "utf8");
assert.match(app, /const dispatching = conversationDispatchIsActive\(conversation\)/u, "队列排空必须等待已接收但仍在准备的消息");
assert.equal((app.match(/conversationHasRunningTask\(conversation, \{ immediateInstructionId(?:: options\.immediateInstructionId)? \}\)/gu) || []).length, 2, "Chat 与 Agent 首次调度都必须遵守接收顺序屏障");
assert.match(app, /conversationHasLiveSupplementTarget/u);
assert.doesNotMatch(app, /imagePromptKind === "ambiguous_image_prompt"/u, "模糊图片文字不得再弹生成选择");
assert.doesNotMatch(app, /imagePromptKind === "image_prompt"/u, "结构化图片提示词不得自动执行生成");
assert.match(app, /mediaDispatch: queuedMediaDispatch/u, "队列必须把已归一化且保留 profileId/model/参数的完整媒体配置交给执行入口");
assert.match(app, /mediaDispatch: lockedMediaDispatch/u);
assert.match(app, /当前对话第一次生成/u);
assert.match(app, /lastSuccessfulMediaSelections/u);
assert.doesNotMatch(app, /source: "default_gpt"/u);

console.log("conversation task and media routing tests passed");
