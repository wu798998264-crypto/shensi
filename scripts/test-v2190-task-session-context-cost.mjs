import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dataRoot = await mkdtemp(join(tmpdir(), "shensi-task-session-test-"));
process.env.SHENSI_DATA_ROOT = dataRoot;

const {
  beginTaskSession,
  buildTaskContextManifest,
  documentTextDelta,
  loadTaskSession,
  taskContextManifestPrompt,
  taskSnapshotReferencePrompt,
  taskSessionStageFingerprint,
  updateTaskSession,
} = await import("../src/server/task-session-manager.mjs");
const {
  buildUsageRecord,
  contextUsageBlocks,
  normalizeProviderUsage,
  summarizeTaskUsage,
} = await import("../src/server/context-usage-ledger.mjs");
const {
  buildBudgetedConversationContext,
  normalizeConversationMessages,
} = await import("../src/conversation-context.js");
const { skillIdsForStage, skillPromptForStage } = await import("../src/skill-routing.js");
const { createCodexAgentProvider } = await import("../src/server/codex-agent-provider.mjs");
const { inheritCandidateTargetProvenance } = await import("../src/candidate-chapters.js");
const { canonicalNovelChapterRequestTarget, classifyRequestMode, hasExplicitFormalAssetWriteIntent } = await import("../src/request-routing.js");
const { normalizeGenerationProfiles } = await import("../src/generation-profiles.js");
const { detectShensiRunProfile } = await import("../src/server/shensi-orchestrator.mjs");

try {
  const appSource = await readFile(join(process.cwd(), "src", "app.js"), "utf8");
  assert.match(appSource, /const fallbackTimer = setTimeout\(continueOnce, 120\)/, "对话准备阶段必须在动画帧被暂停时继续派发");
  assert.match(
    appSource,
    /void sendMessage\(content, \{[\s\S]{0,420}immediateInstructionId,[\s\S]{0,420}guidanceDialog: conversationCreativeGuidanceIsActive\(\),[\s\S]{0,420}\}\);/u,
    "创作引导内层派发必须接管同一条临时指令，避免界面重复显示",
  );
  assert.match(appSource, /payload\.structuredOutput\?\.FormalContent/, "服务端确认的正式内容必须进入候选与落盘链，不能退化成普通聊天文本");

  const provider = createCodexAgentProvider({ machineRoot: dataRoot, appRoot: dataRoot });
  let providerEvent = null;
  const unsubscribe = provider.on("task-session-test", (payload) => { providerEvent = payload; });
  provider.emit("task-session-test", { ok: true });
  assert.deepEqual(providerEvent, { ok: true });
  unsubscribe();

  const chapterInstruction = [
    "现在直接创作《雾都铜心》第1章《雾桥吞火》的正式中文小说正文。",
    "创作过程中执行小说自检、连续性核对与去AI味修订，但只把最终正式正文写入文档，不把说明、检查过程、协议字段或自检报告写进正文。",
    "自动新建或定位标题为“第1章 雾桥吞火”的章节文档并落盘；只处理本章，不生成多个候选稿。",
  ].join("\n");
  const canonicalChapter = canonicalNovelChapterRequestTarget({
    explicitChapterTarget: { documentId: "chapter-1", chapterNumber: 1, chapterTitle: "雾桥吞火" },
  });
  assert.equal(canonicalChapter.title, "第1章 雾桥吞火");
  assert.equal(canonicalChapter.chapterTitle, "雾桥吞火");
  const chapterProfile = detectShensiRunProfile({ prompt: chapterInstruction, routingText: chapterInstruction, activeModule: "manuscript", contextDomain: "novel", requestMode: "creative", targetDocumentId: "chapter-1" });
  assert.equal(chapterProfile.formalAssetWrite, false, "正文内部自检不得把单章任务误路由为多文档报告提交");
  assert.deepEqual(chapterProfile.formalAssetTargets, []);
  const contractedChapterProfile = detectShensiRunProfile({
    prompt: chapterInstruction,
    routingText: chapterInstruction,
    activeModule: "manuscript",
    contextDomain: "novel",
    requestMode: "creative",
    targetDocumentId: "",
    semanticDeliverableType: "novel",
    semanticLane: "task_execution",
    taskContract: {
      protocol: "shensi_task_contract_v1",
      taskType: "writing",
      operation: "create",
      persistence: "commit",
      targetResolution: "exact",
      deliverables: [{ id: "chapter-1-prose", kind: "prose", targetDocumentId: "chapter-1", required: true }],
    },
  });
  assert.equal(contractedChapterProfile.production, true, "writing + prose 合同必须保持正文生产链");
  assert.equal(contractedChapterProfile.diagnostic, false, "正文内部自检不得把权威写作合同降级成诊断任务");
  assert.equal(contractedChapterProfile.strength, "standard");

  const guidanceDecisionCommit = "请把这项决定记入当前作品相关设定、大纲和记忆，然后继续按既定结构推进；此时不写正文。";
  assert.equal(hasExplicitFormalAssetWriteIntent({ text: guidanceDecisionCommit }), true, "创作引导中的明确‘记入’动作必须进入正式资产写入链");
  assert.equal(classifyRequestMode({ text: guidanceDecisionCommit, targetDocumentId: "canon-world", targetModuleId: "canon" }).mode, "creative");
  assert.match(
    appSource,
    /const activeGuidanceFlow = Boolean\(effectiveGuidanceDialog && \(guidanceResources\?\.active \|\| ui\.creativeGuidance\?\.active\)\)/u,
    "引导会话中的明确正式写入必须退出引导态模型调用，使候选进入自动落盘槽",
  );

  const migratedTextSettings = normalizeGenerationProfiles({
    textConnections: [{ id: "text-default", name: "OpenAI GPT", provider: "OpenAI", adapter: "cli", protocol: "responses", model: "gpt-5.6-sol", executionMode: "chat", executionModes: ["chat"], cliPath: "codex" }],
    activeTextConnectionId: "text-default",
    activeTextChatConnectionId: "text-default",
  });
  const migratedCodex = migratedTextSettings.textConnections.find((item) => item.id === "text-default");
  assert.deepEqual(migratedCodex.executionModes, ["agent"], "既有文字配置迁移后只暴露统一 Agent；闲聊由内部快速通道处理");
  assert.equal(migratedCodex.agentEngine, "codex");

  const redirectedChapterTarget = inheritCandidateTargetProvenance(
    { documentId: "chapter-3", title: "第3章 雾桥决战", explicitChapter: true },
    { generationAttemptRequestId: "run-chapter-3", generationBasis: { manifestHash: "basis-3" } },
  );
  assert.equal(redirectedChapterTarget.generationAttemptRequestId, "run-chapter-3", "自动新建章节时不得丢失落盘回执的 Request ID");
  assert.equal(redirectedChapterTarget.generationBasis.manifestHash, "basis-3");

  const documents = {
    "chapter-1": { id: "chapter-1", title: "第一章 铜雨", moduleId: "manuscript", projectId: "work-a", revision: "r1", relativePath: "正文/第一章 铜雨.md", html: `<p>${"铜雨落在长安城。".repeat(140)}</p>` },
    "chapter-2": { id: "chapter-2", title: "第二章 九炉", moduleId: "manuscript", projectId: "work-a", revision: "r8", relativePath: "正文/第二章 九炉.md", html: `<p>${"叶昭在九炉下听见父亲的钟。".repeat(180)}</p>` },
    setting: { id: "setting", title: "气税设定", moduleId: "setting", projectId: "work-a", revision: "r3", relativePath: "设定/气税.md", html: `<p>${"每次呼吸都由铜表计税。".repeat(80)}</p>` },
    history: { id: "history", title: "第二章历史版本", moduleId: "history", projectId: "work-a", revision: "old", relativePath: "历史版本/第二章.md", html: "不应读取的旧正文" },
    trash: { id: "trash", title: "回收站正文", moduleId: "trash", projectId: "work-a", revision: "deleted", relativePath: "回收站/废稿.md", html: "不应读取的回收内容" },
  };
  const manifest = buildTaskContextManifest({
    documents,
    query: "续写第二章，参考第一章与气税设定",
    targetDocumentId: "chapter-2",
    includedIds: ["chapter-1", "chapter-2", "setting"],
    requiredIds: ["chapter-2"],
    workspace: { id: "work-a", title: "雾都铜心", kind: "project" },
  });
  assert.equal(manifest[0].id, "chapter-2", "绑定目标必须排在资料清单第一位");
  assert.equal(manifest[0].required, true);
  assert.equal(manifest[0].readMode, "full");
  assert.ok(manifest.every((item) => item.currentRevision && item.hash && item.summary));
  assert.equal(manifest.some((item) => item.id === "history"), false, "历史版本不得进入资料清单");
  assert.equal(manifest.some((item) => item.id === "trash"), false, "回收站不得进入资料清单");
  assert.match(taskContextManifestPrompt(manifest), /清单只表示/);
  const snapshotPrompt = taskSnapshotReferencePrompt(manifest, { stage: "evaluation" });
  assert.match(snapshotPrompt, /不得读取清单外资料/);
  assert.doesNotMatch(snapshotPrompt, /铜雨落在长安城。铜雨落在长安城。/);
  const editDelta = documentTextDelta({ previous: "第一段\n旧名字：柳明\n第三段", current: "第一段\n新名字：柳青\n第三段", contextCharacters: 8 });
  assert.equal(editDelta.changed, true);
  assert.match(editDelta.text, /旧名字/);
  assert.match(editDelta.text, /新名字/);
  assert.equal(documentTextDelta({ previous: "相同", current: "相同" }).changed, false);

  const taskId = "task_session_2190";
  await beginTaskSession({
    taskId,
    conversationId: "conversation-a",
    requestId: taskId,
    workspace: { kind: "project", id: "work-a", title: "雾都铜心", pathHash: "workspace-hash" },
    association: { enabled: true, documentId: "chapter-2", revision: "r8", hash: manifest[0].hash },
    source: { documentId: "chapter-2", contentType: "novel" },
    target: { requestedTitle: "第三章 铜心", contentType: "novel" },
    operation: "create",
    confirmedRequirements: ["保持中式蒸汽朋克", "不要读取其他作品"],
    conversationLedger: { currentGoal: "续写第三章", capsule: "父亲失踪与九炉有关" },
    documents: Object.fromEntries(manifest.map((item) => [item.id, item])),
    skills: { writer: { id: "writer", name: "小说正文主笔", version: "2", hash: "skill-hash", phases: ["creative"] } },
    readEvents: [{
      stage: "creative",
      documents: [{ id: "chapter-2", title: "第二章 九炉", readMode: "full", fullText: true, compressed: true, chunksRead: 3 }],
      skills: [{ id: "writer", name: "小说正文主笔", version: "2" }],
    }],
  });
  const restarted = await loadTaskSession({ taskId });
  assert.equal(restarted.association.documentId, "chapter-2");
  assert.equal(restarted.documents.history, undefined);
  assert.deepEqual(restarted.confirmedRequirements, ["保持中式蒸汽朋克", "不要读取其他作品"]);
  assert.equal(restarted.readEvents[0]?.documents[0]?.compressed, true, "任务会话必须保留全文压缩读取证据");
  assert.equal(restarted.readEvents[0]?.skills[0]?.name, "小说正文主笔", "任务会话必须保留实际加载 Skill 名称");

  const fingerprintInput = {
    stage: "creative",
    messages: [{ role: "user", content: "续写第三章" }],
    system: "当前规则",
    documents: manifest,
    skills: [{ id: "writer", version: "2", hash: "skill-hash" }],
  };
  const baseFingerprint = taskSessionStageFingerprint(fingerprintInput);
  assert.equal(baseFingerprint, taskSessionStageFingerprint(fingerprintInput), "相同阶段输入必须具备稳定幂等键");
  assert.notEqual(baseFingerprint, taskSessionStageFingerprint({ ...fingerprintInput, messages: [{ role: "user", content: "续写第三章并增加钟楼冲突" }] }), "用户修改后必须重新执行而不是误用缓存");
  await updateTaskSession({
    taskId,
    mutate: (session) => ({ ...session, stageResults: { [baseFingerprint]: { stage: "creative", text: "第三章正式正文", protocol: "responses" } } }),
  });
  assert.equal((await loadTaskSession({ taskId })).stageResults[baseFingerprint].text, "第三章正式正文");

  const responsesUsage = normalizeProviderUsage({ input_tokens: 1200, output_tokens: 500, input_tokens_details: { cached_tokens: 300 }, output_tokens_details: { reasoning_tokens: 80 }, total_tokens: 1700 });
  assert.deepEqual(responsesUsage, { source: "provider", inputTokens: 1200, outputTokens: 500, cachedInputTokens: 300, cacheWriteTokens: 0, reasoningTokens: 80, totalTokens: 1700, actualCost: null });
  const anthropicUsage = normalizeProviderUsage({ input_tokens: 900, output_tokens: 300, cache_creation_input_tokens: 100, cache_read_input_tokens: 200 });
  assert.equal(anthropicUsage.cacheWriteTokens, 100);
  assert.equal(anthropicUsage.cachedInputTokens, 200);
  assert.equal(normalizeProviderUsage(null), null);

  const blocks = contextUsageBlocks({
    system: "系统规则\n当前文档正文",
    messages: [{ role: "user", content: "受控 Skill 内容\n请续写" }],
    documents: "当前文档正文",
    skills: "受控 Skill 内容",
    attachments: [{ text: "本任务附件" }],
  });
  assert.deepEqual([...new Set(blocks.map((item) => item.category))].sort(), ["attachments", "conversation", "documents", "skills", "system"]);
  const usageRecord = buildUsageRecord({ taskId, stage: "creative", protocol: "responses", usage: { input_tokens: 1200, output_tokens: 500 }, blocks });
  assert.equal(usageRecord.usage.inputTokens, 1200);
  assert.equal(usageRecord.measurement, "provider_actual_with_proportional_category_attribution");
  const unknownUsage = buildUsageRecord({ taskId, stage: "cli", protocol: "cli", usage: null, blocks });
  assert.equal(unknownUsage.usage, null);
  assert.equal(unknownUsage.measurement, "characters_only_no_token_estimate");
  assert.equal(summarizeTaskUsage([usageRecord, unknownUsage]).callsWithProviderUsage, 1);

  const longConversation = [];
  for (let index = 1; index <= 24; index += 1) {
    longConversation.push({ id: `u${index}`, role: "user", content: `第${index}轮要求：保持叶昭的目标与九炉气税冲突。${"本轮补充创作细节。".repeat(30)}` });
    longConversation.push({ id: `a${index}`, role: "assistant", content: `第${index}轮答复：已经围绕当前作品继续讨论。${"这是不会再逐字重复的较早说明。".repeat(30)}` });
  }
  const normalized = normalizeConversationMessages(longConversation);
  const naiveCharacters = normalized.reduce((sum, item) => sum + item.content.length + 24, 0);
  const compiled = buildBudgetedConversationContext(longConversation, { maxChars: naiveCharacters * 2 });
  const reduction = 1 - compiled.compiledCharacters / naiveCharacters;
  assert.equal(compiled.stateLedgerApplied, true);
  assert.ok(compiled.messages.some((item) => item.contextCapsule === true), "较早有效要求必须进入状态账本");
  assert.ok(reduction >= 0.4, `重复上下文降幅不足 40%：${(reduction * 100).toFixed(1)}%`);
  assert.match(compiled.capsule.text, /来源 u1/);
  assert.match(compiled.capsule.text, /叶昭的目标与九炉气税冲突/);

  const runtime = {
    slotSkills: {
      guidance: { id: "guide", name: "创作引导", content: "只在规划阶段追问", authorizedCapabilities: ["creative_guidance"] },
      writer: { id: "writer", name: "正文主笔", content: "只在正文阶段写作", authorizedCapabilities: ["novel_prose_writer"] },
      effectReview: { id: "review", name: "效果审阅", content: "只在审阅阶段检查", authorizedCapabilities: ["effect_reviewer"] },
    },
    auxiliarySkills: [],
  };
  const planningPrompt = skillPromptForStage(runtime, "planning");
  const creativePrompt = skillPromptForStage(runtime, "creative");
  const reviewPrompt = skillPromptForStage(runtime, "evaluation");
  assert.match(planningPrompt, /创作引导/);
  assert.doesNotMatch(planningPrompt, /只在正文阶段写作/);
  assert.match(creativePrompt, /正文主笔/);
  assert.doesNotMatch(creativePrompt, /只在规划阶段追问/);
  assert.match(reviewPrompt, /效果审阅/);
  assert.deepEqual(skillIdsForStage(runtime, "planning"), ["guide"]);
  assert.deepEqual(skillIdsForStage(runtime, "creative"), ["writer"]);
  assert.deepEqual(skillIdsForStage(runtime, "evaluation"), ["review"]);

  const persistedRaw = await readFile(join(dataRoot, "task-sessions", `${taskId}.json`), "utf8");
  assert.doesNotMatch(persistedRaw, /apiKey|secret|Bearer /i, "任务会话不得保存 Provider 密钥");

  console.log(JSON.stringify({
    ok: true,
    manifestDocuments: manifest.length,
    excluded: ["history", "trash"],
    contextReductionPercent: Number((reduction * 100).toFixed(1)),
    providerUsageParsed: true,
    stageFingerprintStable: true,
    skillStageIsolation: true,
    documentDeltaIsolation: true,
  }, null, 2));
} finally {
  await rm(dataRoot, { recursive: true, force: true });
}
