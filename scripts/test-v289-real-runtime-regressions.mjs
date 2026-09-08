import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { explicitlyDefersCandidateLanding, explicitlyRequestsBoundDocument, isGenerationAndLandingRequest, isLandingRequest } from "../src/chapter-target.js";
import { buildAdaptiveTaskRoute, generalDocumentContextIds, hasExplicitFormalAssetWriteIntent } from "../src/request-routing.js";
import { generationResultMayDefaultLand } from "../src/generation-attempt-client.js";
import { verifiedLandingManifestReceipt } from "../src/landing-document-links.js";
import { candidateWriteAuthorizationForRecovery } from "../src/candidate-chapters.js";
import { automaticLandingDecision, candidateLandingShouldBeDeferred } from "../src/automatic-landing-policy.js";
import { assistantChoicePrompt } from "../src/conversation-choice-panel.js";
import {
  buildExecutionSourceReceipt,
  executionSourceMarker,
  executionSourceProofContext,
} from "../src/server/execution-source-proof.mjs";
import { addCodexCliOverrides, classifyCliProcessFailure, stripCodexOptionalArgs, summarizeCliFailureDetail } from "../src/server/adapters.mjs";

const target = {
  documentId: "chapter-99",
  revision: "revision-99",
  title: "第99章 实机验收临时文档",
};
const routeFor = (text) => buildAdaptiveTaskRoute({
  text,
  sourceMessageId: "user-real-runtime",
  target,
  targetDocumentId: target.documentId,
  targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision },
});

for (const text of [
  "只回答 CHAT_REAL_OK。不要创建、修改或落盘任何文档。",
  "只回答 AGENT_REAL_OK。不要创建、修改或落盘任何文档。",
  "我想写一个故事，但还没决定是科幻还是悬疑。请让我直接选择题材，不要生成正文，也不要落盘。",
]) {
  const route = routeFor(text);
  assert.equal(route.writeAuthorization.state, "none", text);
  assert.equal(route.taskPolicy.action, "analyze", text);
  assert.equal(route.taskPolicy.commitDisposition, "no_artifact", text);
}

// A failed guidance turn may be retried while the UI still points at the
// first chapter.  The chapter target is context only: the continuation must
// preserve the guidance contract instead of being rerouted into prose.
const failedGuidanceContinuation = buildAdaptiveTaskRoute({
  text: "【上一轮仍在执行的原始目标】\n我想写一个故事，但还没决定是科幻还是悬疑。\n\n【本轮补充或澄清】\n继续刚才的创作引导，不要生成正文，也不要创建或修改文档。",
  authorizationInstruction: "继续刚才的创作引导，不要生成正文，也不要创建或修改文档。",
  sourceMessageId: "user-guidance-retry",
  target: { documentId: "chapter-1", revision: "revision-1", title: "第一章" },
  targetDocumentId: "chapter-1",
  targetDocumentIds: ["chapter-1"],
  expectedRevisions: { "chapter-1": "revision-1" },
  continuesCreativeThread: true,
}, { executionSurface: "agent" });
assert.equal(failedGuidanceContinuation.mode, "creative_guidance",
  "失败后继续创作引导不能因 chapter-1 目标改道正文生产");
assert.equal(failedGuidanceContinuation.writeAuthorization.state, "none",
  "失败后继续创作引导不得产生正文写入授权");
assert.equal(failedGuidanceContinuation.taskPolicy.action, "analyze");
assert.equal(failedGuidanceContinuation.taskPolicy.commitDisposition, "no_artifact");

const replacement = "将当前绑定文档的正文完整替换为“AI写入验证正文B：写入后必须回读成功。”直接落盘，不要解释，不要修改标题。";
const replacementRoute = routeFor(replacement);
assert.equal(isGenerationAndLandingRequest(replacement), true, "明确替换并落盘不能误走旧候选恢复");
const currentDocumentTransformation = "将当前文本转化为视频提示词，落盘到当前文档";
const currentDocumentTransformationRoute = routeFor(currentDocumentTransformation);
assert.equal(isLandingRequest(currentDocumentTransformation), true, "当前文档转换任务必须识别明确落盘意图");
assert.equal(isGenerationAndLandingRequest(currentDocumentTransformation), true, "转换并落盘必须执行模型生成，不能误走旧候选恢复");
assert.equal(explicitlyRequestsBoundDocument({
  text: currentDocumentTransformation,
  boundDocumentId: target.documentId,
  boundDocumentTitle: target.title,
}), true, "明确写回当前文档时必须锁定当前绑定文档");
assert.deepEqual(generalDocumentContextIds({
  text: currentDocumentTransformation,
  currentDocumentId: target.documentId,
  existingDocumentIds: [target.documentId],
}), [target.documentId], "转换任务必须完整读取当前文档作为源内容");
assert.equal(currentDocumentTransformationRoute.writeAuthorization.state, "commit", "明确落盘必须获得正式写入事务授权");
assert.deepEqual(currentDocumentTransformationRoute.writeAuthorization.targetDocumentIds, [target.documentId], "写入目标必须保持为当前文档");
assert.equal(currentDocumentTransformationRoute.taskPolicy.action, "generate", "转换任务必须调用模型生成正式提示词");
assert.equal(currentDocumentTransformationRoute.taskPolicy.commitDisposition, "auto_commit", "单一正式转换结果必须进入确认与事务落盘链");
assert.equal(isLandingRequest("只使用当前模型自身能力自检当前绑定文档，只在对话中回答一条结论，不修改、不落盘。"), false, "否定落盘不能进入候选恢复旁路");
assert.equal(isLandingRequest("只分析当前文档，不写入正文。"), false, "否定写入不能取得落盘意图");
const quotaStderr = [
  "2026-08-23 WARN harmless plugin warning",
  "ERROR: You've hit your usage limit. Try again later.",
].join("\n");
assert.match(summarizeCliFailureDetail(quotaStderr), /usage limit/i, "CLI 错误摘要必须保留真正失败原因而不是前置警告");
assert.equal(classifyCliProcessFailure({ stderr: quotaStderr, exitCode: 1 }).code, "CLI_USAGE_LIMIT");
assert.equal(classifyCliProcessFailure({ stderr: quotaStderr, exitCode: 1 }).retryable, false, "额度耗尽不得伪装成可立即重试错误");
const invalidParamStderr = 'ERROR: {"error":{"code":"INVALID_PARAM","type":"invalid_request_error","message":"当前已连接频道无法原生处理或可靠转换本次协议/参数"}}';
assert.equal(classifyCliProcessFailure({ stderr: invalidParamStderr, exitCode: 1 }).code, "CLI_INVALID_REQUEST");
assert.equal(classifyCliProcessFailure({ stderr: invalidParamStderr, exitCode: 1 }).retryable, false);
const codexSearchArgs = addCodexCliOverrides({
  settings: { adapter: "cli", provider: "OpenAI", cliPath: "codex", model: "gpt-5", webSearchEnabled: true },
  args: ["exec", "-"],
  template: "exec -",
});
assert.ok(codexSearchArgs.indexOf("exec") < codexSearchArgs.indexOf("--enable"), "Codex 搜索特性必须挂在 exec 子命令之后");
assert.equal(codexSearchArgs[codexSearchArgs.indexOf("--enable") + 1], "web_search", "Codex 搜索必须使用当前 CLI 支持的 web_search 特性开关");
assert.deepEqual(stripCodexOptionalArgs(["exec", "--enable", "web_search", "--search", "--model", "gpt-5", "-c", "model_reasoning_effort=\"low\"", "-"]), ["exec", "-"], "参数拒绝后的兼容重试必须移除可选模型和搜索控制参数");
assert.equal(hasExplicitFormalAssetWriteIntent({ text: replacement }), true,
  "明确正文替换并直接落盘必须退出创作引导等待态");
assert.equal(explicitlyDefersCandidateLanding(replacement), false,
  "不修改标题只限制标题字段，不能把正文直接落盘误判为延期");
assert.equal(replacementRoute.writeAuthorization.state, "commit");
assert.equal(replacementRoute.writeAuthorization.action, "replace");
assert.equal(replacementRoute.writeAuthorization.allowBodyMutation, true);
assert.equal(replacementRoute.writeAuthorization.allowTitleMutation, false);
assert.notEqual(replacementRoute.mode, "creative_guidance",
  "明确正式正文替换不能被路由为仍需讨论的创作引导");
assert.equal(replacementRoute.taskPolicy.commitDisposition, "auto_commit",
  "明确直接落盘的单稿替换必须进入自动事务，不能停在候选确认");
const replacementCandidate = "AI写入验证正文B：写入后必须回读成功。";
assert.equal(automaticLandingDecision({
  instruction: replacement,
  result: { candidate: replacementCandidate },
  taskPolicy: replacementRoute.taskPolicy,
  route: replacementRoute,
  target,
}).action, "land", "明确写入授权与单一候选齐备时必须自动落盘");
assert.equal(generationResultMayDefaultLand({
  candidate: replacementCandidate,
  engineExecution: { validationStatus: "passed", landingStatus: "ready" },
}), true, "服务端通过确定性检查的候选必须进入默认写入分支");
assert.equal(candidateLandingShouldBeDeferred({
  route: replacementRoute,
  creativeGuidanceRequested: true,
  guidanceProducedFormalArtifact: false,
  explicitlyDeferred: false,
}), false, "新写入命令的 commit 授权必须覆盖会话残留的创作引导等待态");
assert.equal(candidateLandingShouldBeDeferred({
  route: replacementRoute,
  creativeGuidanceRequested: true,
  guidanceProducedFormalArtifact: false,
  explicitlyDeferred: true,
}), true, "用户明确要求只看候选时仍必须停止自动落盘");
const receiptDocument = { title: "实机验收临时文档" };
const directReceipt = { targetDocumentId: "chapter-99", verified: true, writtenHash: "body-hash", verifiedHash: "body-hash" };
const derivedReceipt = { targetDocumentId: "index-update-log", verified: true, writtenHash: "log-hash", verifiedHash: "log-hash" };
assert.equal(verifiedLandingManifestReceipt({
  result: {
    landingManifest: {
      schemaVersion: 2,
      workspaceKind: "project",
      workspacePath: "C:/test/work",
      workspaceName: "验收作品",
      segments: [{
        documentId: "chapter-99",
        title: "实机验收临时文档",
        receiptVerified: true,
        navigationTarget: { documentId: "chapter-99", workspaceKind: "project", workspacePath: "C:/test/work" },
      }],
      batchLandingReceipt: { verified: true, failed: 0, results: [directReceipt, derivedReceipt] },
    },
  },
  documents: { "chapter-99": receiptDocument },
}), true, "同事务追加的更新日志回执不能把已成功正文写入误报为失败");
assert.equal(candidateWriteAuthorizationForRecovery({}, {
  resultData: { payload: { creativeTask: { writeAuthorization: replacementRoute.writeAuthorization } } },
})?.sourceMessageId, replacementRoute.writeAuthorization.sourceMessageId,
"页面恢复候选时必须从持久任务回执恢复原始写入授权，不能要求用户重复确认");

const content = "完整 Skill 正文：必须保留结尾证据。";
const marker = executionSourceMarker({
  kind: "skill",
  id: "builtin:novel-writer",
  version: "2.0.0",
  content,
});
const wrappedFinalInput = `<shensi_selected_skill>\n${marker}\n${content}\n</shensi_selected_skill>`;
const receipt = buildExecutionSourceReceipt({
  system: wrappedFinalInput,
  sources: [{
    kind: "skill",
    id: "builtin:novel-writer",
    version: "current",
    content,
  }],
  stage: "real_codex_final_input",
});
assert.equal(receipt.verified, true, "实际全文和来源标记存在时，不得因包装层版本字段差异误阻断");
assert.equal(receipt.sources[0].contentHash.length, 64);
const missingDocumentText = "真实当前文档全文，不能由目录或摘要代替。";
const proofContext = executionSourceProofContext({
  system: "结构化项目摘要",
  messages: [],
  sources: [{ kind: "document", id: "chapter-99", revision: "r99", content: missingDocumentText }],
});
assert.match(proofContext, new RegExp(missingDocumentText), "最终输入缺少文档全文时必须按需补入一次");
const noDuplicateContext = executionSourceProofContext({
  system: missingDocumentText,
  messages: [],
  sources: [{ kind: "document", id: "chapter-99", revision: "r99", content: missingDocumentText }],
});
assert.equal(noDuplicateContext.split(missingDocumentText).length - 1, 0, "全文已经存在时不得重复注入正文");

assert.equal(assistantChoicePrompt("请选择科幻或悬疑。"), null, "前端不得再根据回复文本自动推断选择题");
assert.equal(assistantChoicePrompt("请选择题材：科幻，还是悬疑？"), null, "前端不得再根据回复文本自动推断选择题");
assert.deepEqual(assistantChoicePrompt("我建议直接开始写正文。"), null, "普通说明不得误弹选择框");

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /const dynamicModels = dynamicModelsForChannel\(/u, "模型能力联动不得引用未定义 dynamicModels");
assert.match(appSource, /const activeModelAttachments = [\s\S]{0,220}const dynamicModels = dynamicModelsForChannel\(state\.settings\.provider, state\.settings\.adapter\);[\s\S]{0,160}getDynamicAttachmentLimit\(state\.settings, dynamicModels\)/u,
  "活动附件能力计算必须在本地解析动态模型，不能依赖未定义自由变量");
assert.doesNotMatch(appSource, /assistantChoicePrompt\(reply\.content/u, "前端不得再根据回复文本自动猜测选择题");
assert.match(appSource, /typeof option === "string"[\s\S]{0,120}\{ label: option, value: option \}/u,
  "模型返回的字符串选项必须转换为可点击的统一选项按钮");

console.log("Shensi v2.89 real runtime regression tests passed");
