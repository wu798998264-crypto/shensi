import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  formatGenerationDuration,
  monotonicElapsedMs,
  monotonicProgress,
  smoothProgressStep,
  syntheticMediaProgress,
  whiteboardGenerationConnectionPhase,
  whiteboardGenerationMeasurementActive,
  whiteboardGenerationProgressActive,
  whiteboardGenerationProgressTarget,
  whiteboardGenerationStartedAt,
  whiteboardMediaProviderAccepted,
  whiteboardProviderIsDirectGeneration,
  whiteboardProviderQueueVisible,
} from "../src/whiteboard-progress.js";

assert.equal(monotonicProgress(40, 18), 40, "进度不得回退");
assert.equal(monotonicProgress(40, 65), 65, "正常前进进度必须保留");
assert.equal(monotonicProgress(null, 0, { minimum: 1, maximum: 100 }), 1, "运行中的卡片进度不得显示为 0");
assert.equal(monotonicProgress(40, 90, { minimum: 1, maximum: 100, maxStep: 1 }), 41, "流式大块文本不得造成单帧大跳跃");
assert.equal(monotonicProgress(98, 100), 100, "完成状态允许到达 100");
assert.equal(smoothProgressStep(null, 8), 2, "首次真实进度为 8 时，显示必须从 0 平滑追赶，不能直接跳到 8");
assert.equal(smoothProgressStep(7, 8), 8, "显示进度接近真实值时必须正常追平");
assert.equal(smoothProgressStep(40, 18), 40, "平滑显示不得因迟到回包倒退");
assert.equal(whiteboardGenerationProgressTarget({ channel: "image", status: "running", providerTaskId: "provider", submissionState: "submitted", progressPercent: 24 }), 24, "媒体厂商未回传百分比时必须使用阶段进度");
assert.equal(whiteboardGenerationProgressTarget(null), null, "普通非生成卡片渲染时不得因空候选抛出异常");
assert.equal(whiteboardGenerationProgressTarget({ channel: "image", status: "running", providerTaskId: "provider", submissionState: "submitted", providerProgressPercent: 0, progressPercent: 24 }), 24, "厂商占位 0% 不得让卡片进度冻结");
assert.equal(whiteboardGenerationProgressTarget({ channel: "image", status: "running", providerTaskId: "provider", submissionState: "submitted", providerProgressPercent: 38, progressPercent: 24 }), 38, "厂商真实进度应优先显示");
assert.equal(whiteboardGenerationProgressTarget({ channel: "image", status: "running", providerTaskId: "provider", submissionState: "submitted", providerProgressPercent: 100, progressPercent: 100 }), 99, "媒体任务未明确成功前不得显示 100%");
assert.equal(whiteboardGenerationProgressTarget({ channel: "image", status: "complete", providerProgressPercent: 38, progressPercent: 100 }), 100, "媒体任务明确成功后必须显示 100%");
assert.equal(Math.round(syntheticMediaProgress({ elapsedMs: 0, channel: "image" })), 28, "图片模拟进度应从提交阶段平滑接续");
assert.ok(syntheticMediaProgress({ elapsedMs: 60_000, channel: "image" }) > 28, "图片没有厂商进度时不得卡在 28%");
assert.ok(syntheticMediaProgress({ elapsedMs: 60_000, channel: "video" }) < syntheticMediaProgress({ elapsedMs: 60_000, channel: "image" }), "长视频模拟进度应采用更保守的时间曲线");
assert.equal(Math.round(syntheticMediaProgress({ elapsedMs: 24 * 60 * 60_000, channel: "video" })), 99, "响应超时但未失败时模拟进度最高停在 99%");
assert.equal(monotonicElapsedMs({ previous: 12_000, incoming: 8_000, startedAt: 95_000, now: 105_000 }), 12_000, "迟到的服务端计时不得让卡片计时倒退");
assert.equal(monotonicElapsedMs({ previous: 8_000, incoming: 9_000, startedAt: 90_000, now: 105_000 }), 15_000, "本地连续计时应补足迟到的服务端计时");
assert.equal(formatGenerationDuration(1_240), "1秒", "卡片生成耗时不得显示小数秒");
assert.equal(formatGenerationDuration(1_760), "2秒", "卡片生成耗时应四舍五入为整数秒");
assert.equal(formatGenerationDuration(59_600), "1分00秒", "整数秒进位后不得显示 0分60秒");
assert.equal(formatGenerationDuration(61_200, { english: true }), "1m 01s", "英文界面也不得显示小数秒");

const connectingImage = {
  channel: "image",
  status: "submitting",
  jobId: "local-job",
  submissionState: "submitting",
  progressPercent: 28,
};
assert.equal(whiteboardMediaProviderAccepted(connectingImage), false, "只有本地任务、厂商尚未受理时不得误判为生成中");
assert.equal(whiteboardGenerationConnectionPhase(connectingImage), true, "图片提交厂商前必须保持连接阶段");
assert.equal(whiteboardGenerationMeasurementActive(connectingImage), true, "点击生成后的连接阶段必须立即开始计时");
assert.equal(whiteboardGenerationProgressActive(connectingImage), false, "连接阶段不得显示百分比");
assert.equal(whiteboardGenerationStartedAt(connectingImage, { now: 50_000 }), 50_000, "连接阶段必须以点击时刻建立总耗时起点");
assert.equal(whiteboardGenerationMeasurementActive({
  ...connectingImage,
  status: "queued",
  submissionState: "not_submitted",
}), true, "本地排队仍必须累计总耗时");
assert.equal(whiteboardGenerationProgressActive({
  ...connectingImage,
  status: "queued",
  submissionState: "not_submitted",
}), false, "本地排队不得显示百分比");

const acceptedImage = {
  ...connectingImage,
  status: "running",
  providerTaskId: "provider-job",
  submissionState: "submitted",
  submittedAt: "1970-01-01T00:00:40.000Z",
};
assert.equal(whiteboardMediaProviderAccepted(acceptedImage), true, "厂商任务 ID 应确认生成任务已受理");
assert.equal(whiteboardGenerationConnectionPhase(acceptedImage), false, "厂商受理后必须离开连接阶段");
assert.equal(whiteboardGenerationMeasurementActive(acceptedImage), true, "厂商受理并运行后必须显示生成进度和耗时");
assert.equal(whiteboardGenerationProgressActive(acceptedImage), true, "厂商真正运行后才显示百分比");
assert.equal(whiteboardGenerationProgressActive({
  ...acceptedImage,
  providerErrorCode: "DREAMINA_PROVIDER_SESSION_RESTORE_PENDING",
}), false, "即梦恢复原任务查询会话时只显示状态和计时，不得显示虚假生成百分比");
assert.equal(whiteboardGenerationStartedAt(acceptedImage, { now: 50_000 }), 50_000, "没有本地起点时才以当前时刻建立总耗时起点");
const acceptedQueuedImage = { ...acceptedImage, status: "queued", providerStatus: "queued", providerQueuePosition: 3, providerQueueLength: 12 };
assert.equal(whiteboardGenerationMeasurementActive(acceptedQueuedImage), true, "厂商排队阶段必须继续累计总耗时");
assert.equal(whiteboardGenerationProgressActive(acceptedQueuedImage), false, "厂商排队阶段不得显示百分比");
assert.equal(whiteboardGenerationProgressTarget(acceptedQueuedImage), null, "厂商排队阶段不得暴露历史或合成百分比");
assert.equal(whiteboardGenerationProgressActive({ ...acceptedQueuedImage, model: "seedance2.5" }), false, "Seedance 2.5 返回真实队列位置时也不得显示生成进度");
assert.equal(whiteboardProviderIsDirectGeneration({ model: "seedance2.5" }), true, "Seedance 2.5 必须识别为直连生成模型");
assert.equal(whiteboardProviderIsDirectGeneration({ request: { settings: { model: "seedance2.5" } } }), true, "应从任务设置识别 Seedance 2.5");
assert.equal(whiteboardProviderQueueVisible({ model: "seedance2.5", providerStatus: "queued", providerQueuePosition: 3, providerQueueLength: 12 }), true, "Seedance 2.5 返回真实队列位置时必须显示厂商排队");
assert.equal(whiteboardGenerationProgressActive({ ...acceptedQueuedImage, model: "seedance2.5", providerQueuePosition: 0, providerQueueLength: 0 }), true, "Seedance 2.5 只有 queued 占位状态且没有真实队列数据时应按处理中显示进度");
assert.equal(whiteboardProviderQueueVisible({ model: "seedance2.0", providerStatus: "queued", providerQueuePosition: 0, providerQueueLength: 0 }), false, "缺少真实队列数据时不得显示共 0 人");
assert.equal(whiteboardProviderQueueVisible({ model: "other-video", providerStatus: "queued", providerQueuePosition: 3, providerQueueLength: 12 }), true, "其他模型有真实队列数据时必须显示排队");
assert.equal(whiteboardGenerationMeasurementActive({ channel: "text", status: "connecting" }), true, "文本点击生成后的连接阶段也必须立即计时");
assert.equal(whiteboardGenerationProgressActive({ channel: "text", status: "connecting" }), false, "文本连接阶段不得显示百分比");
assert.equal(whiteboardGenerationMeasurementActive({ channel: "text", status: "streaming", jobId: "text-job" }), true, "文本模型请求开始后必须显示生成进度和耗时");
assert.equal(whiteboardGenerationProgressActive({ channel: "text", status: "streaming", jobId: "text-job" }), true, "文本流式生成阶段必须显示百分比");
assert.equal(whiteboardGenerationMeasurementActive({ channel: "image", status: "complete", cardApplyStage: "saving" }), true, "厂商完成后的卡片保存阶段必须继续累计总耗时");
assert.equal(whiteboardGenerationMeasurementActive({ channel: "text", status: "complete", cardApplyStage: "verifying" }), true, "文字回读确认阶段也必须继续累计总耗时");
assert.equal(whiteboardGenerationMeasurementActive({ channel: "image", status: "complete" }), false, "回读完成后计时必须冻结，不能继续增长");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
assert.match(app, /whiteboardGenerationConnectionPhase, whiteboardGenerationMeasurementActive, whiteboardGenerationProgressActive, whiteboardGenerationProgressTarget, whiteboardGenerationStartedAt, whiteboardMediaProviderAccepted \} from "\.\/whiteboard-progress\.js\?v=5\.2\.6-generation-phases"/u);
assert.doesNotMatch(app, /totalSeconds\.toFixed\(1\).*秒/u, "卡片与任务卡生成耗时不得再显示小数秒");
assert.match(app, /normalizedPatch\.progressPercent = monotonicProgress\(/u);
assert.match(app, /normalizedPatch\.elapsedMs = monotonicElapsedMs\(/u);
assert.match(app, /Math\.max\(1, monotonicElapsedMs\(\{ previous: candidate\.elapsedMs, startedAt: candidate\.startedAt \}\)\)/u, "任务完成或停止时计时也不得回退");
assert.match(app, /progressPercent: Math\.min\(92, Math\.max\(currentProgress, Math\.min\(textEstimate, currentProgress \+ 1\)\)\)/u);
assert.match(app, /providerProgressPercent = monotonicProgress\(/u);
assert.match(app, /syntheticMediaProgress\(\{ elapsedMs, channel \}\)/u, "白板媒体任务缺少厂商进度时必须持续推进模拟进度");
assert.match(app, /maximumProgress = active \? 99 : 100/u, "对话媒体任务未完成时也不得模拟到 100%");
assert.match(app, /displayProgressPercent:[\s\S]{0,180}\? Number\(existing\.displayProgressPercent\)[\s\S]{0,80}: 0/u);
assert.match(app, /scheduleWhiteboardProgressDisplay\(candidateKey\)/u);
assert.match(app, /visibleGenerationProgress = Boolean\(candidate && whiteboardGenerationProgressActive\(candidate\) && whiteboardProgressTarget\(candidate\) !== null\)/u);
assert.match(app, /candidateConnecting[\s\S]{0,180}正在连接生成服务/u, "连接阶段必须显示连接文案而不是正在生成");
assert.match(app, /candidate && \(generationMeasurementActive \|\| \(candidateInterrupted && generationMeasurementStarted\)\)/u, "连接和排队阶段必须保留总耗时指标");
assert.match(app, /厂商排队[\s\S]{0,220}当前第/u, "厂商排队必须明确显示当前位置语义");
assert.match(app, /厂商排队[\s\S]{0,220}共/u, "厂商排队必须明确显示总人数语义");
assert.match(app, /const beginWhiteboardSubmissionFeedback[\s\S]{0,520}status: "connecting"/u, "点击生成后必须立即建立卡片状态与计时");
assert.match(app, /cardApplyStage: job\.status === "complete" \? "saving" : ""/u, "任务完成回包必须无缝进入卡片保存阶段，不能出现状态空窗");
assert.match(app, /const applyCompletedWhiteboardGenerationJob[\s\S]{0,260}updateWhiteboardCompletedApplyStage\(job, "saving"\)/u, "落盘开始前必须先显示保存状态");
assert.match(app, /updateWhiteboardCompletedApplyStage\(job, "verifying"\);\s+const cardReadback = await verifyWhiteboardGenerationCardReadback/u, "回读开始前必须先显示回读状态");
assert.match(app, /await markWhiteboardGenerationJobApplied[\s\S]{0,180}finalizeWhiteboardCompletedCandidate\(job\)/u, "只有回读和应用标记成功后才能移除活动候选状态");
assert.match(app, /if \(ownsCandidate && !retainCandidateUntilVerified\)/u, "回读确认前不得提前清除卡片状态");
assert.match(app, /completedGenerationStatusVisible = Boolean\(!candidate && !generating && !generationElapsedDismissed && completedGenerationElapsedMs > 0\)/u, "文字、图片和视频成功回填后都必须继续固定显示完整生成状态");
assert.match(app, /completedGenerationStatusVisible \? uiText\("生成成功"\)/u, "成功卡片左上角必须明确显示生成成功，不能退化成没有状态含义的耗时文字");
assert.match(app, /candidate\s+\? durableMediaCandidate \? providerQueueLabel \|\| mediaGenerationPhaseText\(candidate\)/u, "候选任务仍存在时必须始终显示状态文案，不能因未知中间态静默消失");
assert.match(app, /queueLength !== null && queueLength > 0/u, "厂商未返回有效队列总人数时不得显示“共 0 人”");
assert.match(app, /queuePosition !== null && queuePosition > 0/u, "厂商未返回有效队列位置时不得伪造“当前第 1 位”");
assert.match(app, /data-generation-complete-status="true" title="点击卡片隐藏本次生成状态"/u, "成功状态必须保留到用户点击卡片为止");
assert.match(app, /querySelector\(":scope > \.whiteboard-card-kind\[data-generation-complete-status=\\"true\\"\]"\)[\s\S]{0,420}status\.remove\(\)/u, "点击卡片必须一次性隐藏完整成功状态，而不是只移除耗时");
assert.match(app, /if \(card\) dismissWhiteboardGenerationElapsed\(card\)/u, "完成状态只能在用户点击对应卡片后隐藏");
assert.match(app, /const storedWhiteboardDismissedGenerationElapsed[\s\S]{0,800}WHITEBOARD_DISMISSED_GENERATION_ELAPSED_KEY/u, "用户已点击隐藏的完成耗时必须在重启后保持隐藏");
assert.match(app, /const storedWhiteboardGenerationCompletionTimes[\s\S]{0,1200}persistWhiteboardGenerationCompletionTimes/u, "回读完成时的最终总耗时必须跨重绘和重启保持稳定");
assert.match(app, /patch\.status === "complete"[\s\S]{0,220}candidate\.cardApplyStage \|\| "saving"/u, "瞬时完成的任务也必须直接进入保存阶段，不能闪出空状态");
assert.match(app, /completedResultPendingApply[\s\S]{0,520}retryCompletedWhiteboardGenerationApply\(durableJob, \{ beforeCanvas \}\)[\s\S]{0,160}不会重新调用模型/u, "文字已生成但回填失败时必须保留任务并仅重试回填");
assert.match(app, /candidate && !candidateApplyFailed[\s\S]{0,240}candidateApplying/u, "卡片回填失败后不得继续显示为生成中或转圈");
assert.match(app, /candidateApplyFailed[\s\S]{0,180}结果已生成，卡片回填失败/u, "回填失败必须保留明确可见状态");
assert.match(app, /data-media-job-action="reapply"[\s\S]{0,240}重新回填/u, "回填失败卡片必须提供仅使用既有结果的重新回填按钮");
assert.match(app, /for \(const option of executionModeSelect\.options\)[\s\S]{0,220}option\.disabled = false/u, "模型设置的 Chat、Agent 与双模式必须始终可选");
assert.doesNotMatch(app, /executionModeSelect\.value = modeValueForCapabilities/u, "能力探针不得再自动改写用户选择的使用模式");
assert.match(app, /const selectedExecutionMode = control\("textExecutionMode"\)\.value[\s\S]{0,2200}control\("textExecutionMode"\)\.value = selectedExecutionMode/u, "切换 Agent 运行器后必须恢复用户明确选择的模式");
assert.match(app, /const hasVisibleTextContent = Boolean\(String\(visibleText \?\? ""\)\.trim\(\)\)/u);
assert.match(app, /pendingGenerationType = !hasGeneratedContent && !hasVisibleTextContent/u, "有文字内容的卡片不得继续显示居中生成类型图标");
assert.match(app, /card\.dataset\.cardHasText === "true"[\s\S]{0,180}whiteboard-card-generation-type/u, "增量同步生成类型图标时也必须尊重现有文字内容");
assert.match(app, /\$\{generatedNodeTitle\}\s+\$\{kindMarkup\}\s+\$\{generationTypeIndicator\}/u, "生成状态必须位于卡片根层，不能随媒体内容分支丢失");
assert.match(styles, /\.whiteboard-card\.generating \.whiteboard-generation-status:not\(\.interrupted\)[\s\S]{0,320}color: var\(--text-secondary\)/u);
assert.match(styles, /\.whiteboard-generation-status \{[\s\S]{0,80}z-index: 8/u, "生成状态必须稳定显示在图片、视频和卡片交互层之上");
assert.match(styles, /\.whiteboard-generation-phase-label[\s\S]{0,180}text-overflow: ellipsis/u, "长状态文案必须省略，不能挤掉生成指标");
assert.match(styles, /\.whiteboard-generation-metrics[\s\S]{0,100}flex: 0 0 auto/u, "生成百分比和耗时必须保持完整可见");
assert.match(styles, /\.whiteboard-card:has\(\.whiteboard-generation-metrics\.complete\) textarea[\s\S]{0,80}padding-top: 30px/u, "文字卡片完成总耗时不得遮挡正文");
assert.match(styles, /#whiteboardAgentVerification[\s\S]{0,120}grid-column: 1 \/ -1/u, "白板 Agent 检查栏必须独占完整横排");
assert.match(styles, /\.whiteboard-generation-popover:not\(\.is-expanded\):has\(\.whiteboard-generation-references:not\(\[hidden\]\)\) \{[\s\S]{0,180}height: min\(362px, calc\(100vh - 20px\)\)/u, "存在参考时桌面操作栏必须为单横排和滚动条预留高度");
assert.match(styles, /\.whiteboard-generation-popover:not\(\.is-expanded\) \.whiteboard-generation-reference-list \{[\s\S]{0,240}padding: 1px 0 12px;[\s\S]{0,100}flex-wrap: nowrap;[\s\S]{0,80}overflow-x: auto;[\s\S]{0,80}overflow-y: hidden/u, "超多参考必须保持单横排并仅横向滚动");
assert.match(styles, /\.whiteboard-generation-reference-list::-webkit-scrollbar \{[\s\S]{0,60}height: 8px/u, "参考横向滚动条必须使用独立安全槽位");
assert.match(styles, /#whiteboardVideoDialog\.is-smart-multiframe:not\(\.is-expanded\) \.whiteboard-generation-reference-list \{[\s\S]{0,80}min-height: 88px/u, "多帧参考必须为 72px 缩略图和滚动条保留完整高度");
assert.match(styles, /@media \(max-width: 720px\)[\s\S]{0,420}\.whiteboard-generation-popover:not\(\.is-expanded\):has\(\.whiteboard-generation-references:not\(\[hidden\]\)\) \{[\s\S]{0,120}height: min\(438px, calc\(100vh - 20px\)\)/u, "窄屏存在参考时也必须自适应增加操作栏高度");
console.log("whiteboard progress monotonicity tests passed");
