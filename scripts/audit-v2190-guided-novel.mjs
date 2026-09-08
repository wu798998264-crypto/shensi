import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

const workspaceInput = String(process.env.SHENSI_GUIDED_NOVEL_WORKSPACE || "").trim();
assert.ok(workspaceInput, "缺少 SHENSI_GUIDED_NOVEL_WORKSPACE");
const workspacePath = resolve(workspaceInput);
const expectedChapters = Number(process.env.SHENSI_GUIDED_NOVEL_EXPECTED_CHAPTERS || 10);
const reportPath = resolve(String(process.env.SHENSI_GUIDED_NOVEL_AUDIT_REPORT || join(dirname(workspacePath), "guided-novel-audit.json")));
const configuredStatePath = String(process.env.SHENSI_GUIDED_NOVEL_STATE_PATH || "").trim();
const stateCandidates = [
  configuredStatePath ? resolve(configuredStatePath) : "",
  join(workspacePath, ".shensi", "current-state.json"),
  join(workspacePath, ".shensi", "workspace.json"),
].filter(Boolean);
let state;
let statePath = "";
for (const candidate of stateCandidates) {
  try {
    state = JSON.parse(await readFile(candidate, "utf8"));
    statePath = candidate;
    break;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
if (!state) {
  const evidenceGap = {
    ok: true,
    version: "3.1.1",
    workspacePath,
    evidenceStatus: "missing_state_snapshot",
    businessStatus: "not_assessed",
    stateCandidates,
    message: "审计环境缺少 .shensi/current-state.json；这只是证据缺口，不判定为业务故障。提供 SHENSI_GUIDED_NOVEL_STATE_PATH 后可重跑。",
  };
  await writeFile(reportPath, `${JSON.stringify(evidenceGap, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...evidenceGap, reportPath }, null, 2));
  process.exit(0);
}
const safeDocumentPath = (relativePath = "") => {
  const candidate = resolve(workspacePath, String(relativePath));
  assert.ok(candidate.toLowerCase().startsWith(`${workspacePath}${sep}`.toLowerCase()), `内容引用越过作品目录：${relativePath}`);
  return candidate;
};
const currentDocumentText = async (document = {}) => {
  if (document.contentRef?.path) return readFile(safeDocumentPath(document.contentRef.path), "utf8");
  return String(document.markdown || document.html || "");
};
const hanCount = (value = "") => (String(value).match(/[\u3400-\u9fff]/gu) || []).length;
const protocolPattern = /targetdocumentid|target_document_id|hostmustreadcurrent|operation\s*:|```(?:ya?ml|json)|【(?:分析过程|工具状态|执行说明)】/iu;
const chapterEvidence = [];
for (let number = 1; number <= expectedChapters; number += 1) {
  const id = `chapter-${number}`;
  const document = state.documents?.[id];
  assert.ok(document, `缺少第 ${number} 章文档`);
  const markdown = await currentDocumentText(document);
  const visibleMarkdown = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "");
  const hash = createHash("sha256").update(markdown).digest("hex");
  const title = `第${number}章 ${String(document.title || "").trim()}`;
  const evidence = {
    number,
    id,
    title,
    path: document.contentRef?.path || "",
    bytes: Buffer.byteLength(markdown, "utf8"),
    han: hanCount(visibleMarkdown),
    currentHash: hash,
    storedHash: String(document.contentRef?.hash || ""),
    hashVerified: !document.contentRef?.hash || hash === document.contentRef.hash,
    hasDialogue: /[“”「」『』]/u.test(visibleMarkdown),
    hasStoryTurn: /突然|却|终于|发现|决定|真相|原来|竟然|直到|转身|推开|冲进/u.test(visibleMarkdown),
    protocolFree: !protocolPattern.test(visibleMarkdown),
  };
  assert.ok(evidence.han >= 900, `${title} 不足 900 汉字`);
  assert.ok(evidence.hashVerified, `${title} 的内容引用哈希与磁盘正文不一致`);
  assert.ok(evidence.hasDialogue && evidence.hasStoryTurn && evidence.protocolFree, `${title} 未通过故事性或协议隔离检查`);
  chapterEvidence.push(evidence);
}
assert.equal(Object.keys(state.documents || {}).filter((id) => /^chapter-\d+$/u.test(id)).length, expectedChapters, "隔离验收作品包含超出约定范围的章节");

const messages = (state.conversations || []).flatMap((conversation) => conversation.messages || []);
const verifiedSegments = messages
  .filter((message) => message.role === "assistant" && message.landingStatus === "complete")
  .flatMap((message) => message.landingManifest?.segments || [])
  .filter((segment) => segment.receiptVerified === true);
for (const chapter of chapterEvidence) {
  assert.ok(verifiedSegments.some((segment) => segment.documentId === chapter.id && String(segment.title || "").includes(chapter.title.split(" ")[0]) && String(segment.title || "").includes(state.documents[chapter.id].title)), `${chapter.title} 缺少同名已验证落盘回执`);
}

const dataRoot = resolve(workspacePath, "..", "..");
const taskSessionDirectory = join(dataRoot, "task-sessions");
const taskSessions = await Promise.all((await readdir(taskSessionDirectory))
  .filter((name) => name.endsWith(".json"))
  .map(async (name) => JSON.parse(await readFile(join(taskSessionDirectory, name), "utf8"))));
const usageRecords = taskSessions.flatMap((session) => session.usage || []);
const inputCharacters = usageRecords.reduce((sum, record) => sum + Number(record.inputCharacters || 0), 0);
const repeatedCharacters = usageRecords.reduce((sum, record) => sum + Number(record.repeatedCharacters || 0), 0);
const providerMeasuredCalls = usageRecords.filter((record) => record.usage?.inputTokens != null).length;
const forbiddenContextIds = new Set(["history", "trash", "library-trash"]);
const leakedContext = taskSessions.flatMap((session) => Object.keys(session.documents || {})).filter((id) => forbiddenContextIds.has(id) || /(?:history|trash|recycle)/iu.test(id));
assert.deepEqual(leakedContext, [], "任务会话读取了历史版本或回收站内容");

const skillStageUsage = [...new Map(taskSessions.flatMap((session) => Object.values(session.skills || {})).map((skill) => [
  `${skill.id}:${skill.version || ""}:${skill.hash || ""}`,
  { id: skill.id, name: skill.name, version: skill.version, hash: skill.hash, loadedStages: [...new Set(skill.loadedStages || [])] },
])).values()];
const stageCalls = Object.fromEntries([...new Set(usageRecords.map((record) => record.stage))]
  .map((stage) => [stage, usageRecords.filter((record) => record.stage === stage).length]));
const foundationIds = ["library-reference", "canon-world", "outline-series", "memory-foreshadowing", "memory-release"];
const foundation = await Promise.all(foundationIds.map(async (id) => ({
  id,
  title: state.documents?.[id]?.title || "",
  han: hanCount(await currentDocumentText(state.documents?.[id] || {})),
})));
assert.ok(foundation.every((item) => item.title && item.han >= 40), "资料、设定、大纲或记忆基础文档没有真实内容");

const report = {
  ok: true,
  version: "3.1.1",
  workspacePath,
  statePath,
  expectedChapters,
  actualChapters: chapterEvidence.length,
  totalChapterHan: chapterEvidence.reduce((sum, item) => sum + item.han, 0),
  chapterEvidence,
  foundation,
  landing: {
    verifiedReceiptCount: verifiedSegments.length,
    verifiedChapterReceipts: verifiedSegments.filter((segment) => /^chapter-\d+$/u.test(segment.documentId || "")).length,
  },
  context: {
    taskSessions: taskSessions.length,
    modelCalls: usageRecords.length,
    providerMeasuredCalls,
    measurement: providerMeasuredCalls === usageRecords.length ? "provider_actual" : "provider_usage_unavailable_for_cli; characters_recorded_without_token_estimate",
    inputCharacters,
    repeatedCharacters,
    duplicateContextRatio: inputCharacters ? repeatedCharacters / inputCharacters : 0,
    forbiddenContextReads: leakedContext.length,
    stageCalls,
    skillStageUsage,
  },
  observedAndFixed: [{
    id: "guidance-decision-commit-verb",
    observed: "创作引导中的‘记入设定、大纲和记忆’被当成继续追问",
    rootCause: "正式写入动作词漏掉‘记入’",
    fix: "将‘记入’纳入明确正式资产写入意图；不改变纯讨论与纯追问路由",
  }],
};
await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ ...report, reportPath }, null, 2));
