import { cleanFormalDocumentContent, isAssistantOperationalText } from "./obsidian-markdown.js";
import { requestedArtifactTarget } from "./artifact-target.js";
import { validateFormalWriteAuthorization } from "./formal-write-authorization.js";
import { shouldSuppressAutomaticFormalLanding } from "./formal-write-confirmation.js";
import { contextualInsertionRequested, terminalContinuationRequested } from "./document-edit-plan.js";
import { validateTaskContractForExecution } from "./task-contract.js";

const valueText = (value = "") => String(value ?? "").replace(/\r\n?/g, "\n").trim();

const EXPLICIT_NO_LANDING = /(?:不要|无需|暂不|先别|禁止)(?:写入|落盘|保存|应用到|修改)(?:文档|正文|文件)?|(?:只|仅)(?:在)?(?:对话|聊天)(?:里|中)?(?:回答|展示|输出)|do\s+not\s+(?:save|write|apply)/iu;
const READ_ONLY_TASK = /^(?:请)?(?:解释|说明|分析|讨论|回答|告诉我|为什么|是否|能否|怎么看|评价|总结一下)(?![\s\S]*(?:写|生成|创作|改写|续写|润色|替换|修改|落盘|文档))/u;
const READ_ONLY_CAPABILITY_QUERY = /(?:(?:本次|这次|此次|当前|刚才).{0,18}(?:实际)?(?:读取|参考|使用|调用|写入|落盘|覆盖).{0,28}(?:什么|哪些|哪里|内容|资料|来源|文档|skill|技能|规则))|(?:(?:能否|是否|可不可以|会不会|有没有|为什么|为何|怎么|如何|什么原因).{0,36}(?:读取|参考|调用|使用|写入|落盘|覆盖|修改文档|自动保存))|(?:(?:读取|参考|调用|使用|写入|落盘|覆盖|自动保存).{0,28}(?:吗|呢|[?？]|为什么|怎么|如何|哪些|什么))/iu;
const MULTIPLE_CANDIDATES = /(?:多个|两(?:个|版)|三(?:个|版)|几(?:个|版)|不同)(?:候选|版本|方案)|候选\s*[A-CＡ-Ｃ1-3一二三]|(?:给|写|生成).{0,10}(?:版|种)(?:供|让我)(?:选择|挑选)/iu;
const META_SECTION_HEADING = /^(?:#{1,6}\s*)?(?:【|\[)?(?:修改说明|调整说明|改动说明|执行说明|完成说明|自检报告|检查报告|诊断结果|变更摘要|处理结果|写入说明|落盘说明|工作记录|分析过程|思考过程)(?:】|\])?\s*[:：]?\s*$/u;
const STATUS_ONLY_LINE = /^(?:已|已经|现已|本轮已|任务已)(?:为你|按要求|完成|生成|写入|落盘|保存|更新|修改|替换|创建)[^\n]{0,100}[。！!]$/u;
const BLOCKED_OR_DIAGNOSTIC_LEAD = /^(?:(?:我(?:还|暂时)?\s*)?(?:当前|本轮|这次)?(?:无法|不能|未能|尚未|没有|未)(?:可靠地?)?|由于|因为|缺少|请(?:先|补充|提供|选择|打开)|需要(?:你)?先)[^\n]{0,260}(?:续写|生成|创作|写入|落盘|保存|读取|上下文|资料|来源|文档|章节|skill|技能|任务)/iu;

export const formalArtifactCommitEligibility = ({ route = null, runStatus = "" } = {}) => {
  const status = valueText(runStatus).toLocaleLowerCase();
  if (status && status !== "completed") return { eligible: false, reason: "run_not_completed" };
  if (!route || typeof route !== "object") return { eligible: false, reason: "missing_managed_route" };
  const contractDecision = validateTaskContractForExecution(route.taskContract ?? route.taskPolicy?.taskContract ?? null);
  if (contractDecision.authoritative) {
    if (!contractDecision.valid) return { eligible: false, reason: "invalid_task_contract" };
    if (contractDecision.persistence === "none" || contractDecision.deliverables.length === 0) {
      return { eligible: false, reason: "task_contract_has_no_artifact" };
    }
  }
  const authorization = route.writeAuthorization ?? route.taskPolicy?.writeAuthorization ?? null;
  const authorizationCheck = validateFormalWriteAuthorization(authorization, {
    requiredState: authorization?.state === "candidate_only" ? "candidate_only" : "commit",
  });
  if (!authorizationCheck.valid) return { eligible: false, reason: authorizationCheck.reason };
  const action = valueText(route.action || route.taskPolicy?.action).toLocaleLowerCase();
  const commitOwner = valueText(route.commitOwner || route.taskPolicy?.commitOwner).toLocaleLowerCase();
  const commitDisposition = valueText(route.commitDisposition || route.taskPolicy?.commitDisposition).toLocaleLowerCase();
  // A clear, authorized write is sufficient to enter the managed landing
  // path. `formalArtifactExpected` is descriptive metadata for UI/candidate
  // presentation, not a second permission gate. This also allows explicit
  // writes of content types that were not preclassified as formal.
  if (!["generate", "modify"].includes(action)) return { eligible: false, reason: "non_artifact_action" };
  if (commitOwner !== "shensi_transaction") return { eligible: false, reason: "untrusted_commit_owner" };
  if (commitDisposition === "no_artifact") return { eligible: false, reason: "no_artifact_disposition" };
  return { eligible: true, reason: "managed_artifact_task" };
};

export const formalArtifactLandingPolicy = ({ instruction = "", candidateCount = 1, technicalError = "", writeAuthorization = null, candidate = "", target = null, contentType = "" } = {}) => {
  const prompt = valueText(instruction);
  if (technicalError) return { disposition: "technical_error", shouldLand: false, reason: "technical_error" };
  const authorizationCheck = validateFormalWriteAuthorization(writeAuthorization, {
    requiredState: "commit",
    instruction,
    candidate,
  });
  if (!authorizationCheck.valid) {
    return {
      disposition: writeAuthorization?.state === "candidate_only" ? "candidate_only" : "conversation_only",
      shouldLand: false,
      reason: authorizationCheck.reason,
    };
  }
  if (EXPLICIT_NO_LANDING.test(prompt)) return { disposition: "conversation_only", shouldLand: false, reason: "explicit_no_landing" };
  if (candidateCount > 1 || MULTIPLE_CANDIDATES.test(prompt)) return { disposition: "await_selection", shouldLand: false, reason: "multiple_candidates" };
  if (READ_ONLY_TASK.test(prompt) || READ_ONLY_CAPABILITY_QUERY.test(prompt)) return { disposition: "conversation_only", shouldLand: false, reason: "read_only" };
  if (writeAuthorization?.state !== "commit"
    && shouldSuppressAutomaticFormalLanding({ instruction: prompt, target, contentType })) return { disposition: "conversation_only", shouldLand: false, reason: "non_formal_default" };
  return { disposition: "auto_commit", shouldLand: true, reason: "formal_artifact_default" };
};

const removeMetaSections = (value = "") => {
  const unfenced = valueText(value)
    .replace(/^\s*(?:```|~~~)[^\n]*\n/u, "")
    .replace(/\n(?:```|~~~)\s*$/u, "");
  const lines = unfenced.split("\n");
  const output = [];
  for (const line of lines) {
    if (META_SECTION_HEADING.test(line.trim())) break;
    if (/^\s*\[[^\]]+\]\((?:shensi|document|note):\/\/[^)]+\)\s*$/iu.test(line)) continue;
    if (/^(?:写入|落盘)(?:成功|完成|回执)\s*[:：]/u.test(line.trim())) continue;
    output.push(line);
  }
  while (output.length && STATUS_ONLY_LINE.test(output.at(-1).trim())) output.pop();
  return output.join("\n").trim();
};

const stripLeadingArtifactTitle = (content = "", title = "") => {
  const expected = valueText(title).replace(/^#{1,6}\s*/u, "").replace(/[\s　]+/gu, " ").trim();
  if (!expected) return valueText(content);
  const lines = valueText(content).split("\n");
  const first = lines.findIndex((line) => line.trim());
  if (first < 0) return "";
  const actual = lines[first].trim().replace(/^#{1,6}\s*/u, "").replace(/[\s　]+/gu, " ").trim();
  if (actual !== expected) return valueText(content);
  lines.splice(first, 1);
  return lines.join("\n").trim();
};

const normalizedKey = (value = "") => String(value).replace(/[^a-z0-9]/giu, "").toLowerCase();

const objectValue = (object, ...aliases) => {
  if (!object || typeof object !== "object" || Array.isArray(object)) return undefined;
  const wanted = new Set(aliases.map(normalizedKey));
  const entry = Object.entries(object).find(([key]) => wanted.has(normalizedKey(key)));
  return entry?.[1];
};

const structuredJsonSources = (response = "") => {
  const source = valueText(response);
  const candidates = [source.replace(/^```(?:json)?\s*|\s*```$/giu, "").trim()];
  for (const match of source.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)) candidates.push(String(match[1] || "").trim());
  const firstBrace = source.indexOf("{");
  const lastBrace = source.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(source.slice(firstBrace, lastBrace + 1).trim());
  return [...new Set(candidates)].filter((candidate) => candidate.startsWith("{") && candidate.endsWith("}"));
};

const STRUCTURED_TEXT_KEYS = new Set([
  "artifactid", "deliverableid", "id", "title", "documenttitle", "documentname", "name",
  "content", "body", "documentbody", "documentcontent", "text",
  "contenttype", "contentformat", "documenttype", "type",
  "targetdocumentid", "documentid", "targetdirectoryid", "directoryid",
  "targetrevision", "operation", "operationtype", "action",
]);
const STRUCTURED_TEXT_PROTOCOL_KEYS = new Set([
  "targetdocumentid", "documentid", "targetrevision", "operation", "operationtype", "contentformat",
]);

const unquoteStructuredScalar = (value = "") => {
  const source = valueText(value);
  const quoted = source.match(/^(["'])([\s\S]*)\1$/u);
  return quoted ? quoted[2].trim() : source;
};

// Some CLI agents return the delivery contract as a YAML-like block without a
// valid JSON envelope. Parse only blocks that contain an internal protocol key
// plus an explicit content/body marker, so ordinary prose containing “标题：”
// can never be mistaken for a host delivery contract.
const structuredTextEnvelope = (response = "") => {
  const lines = valueText(response).split("\n");
  for (let start = 0; start < lines.length; start += 1) {
    const first = lines[start].trim().replace(/^```(?:ya?ml)?\s*$/iu, "");
    const firstMatch = first.match(/^["']?([a-z][a-z0-9_-]*)["']?\s*[:：]\s*(.*)$/iu);
    if (!firstMatch || !STRUCTURED_TEXT_PROTOCOL_KEYS.has(normalizedKey(firstMatch[1]))) continue;
    const artifact = {};
    let sawProtocol = false;
    let contentIndex = -1;
    let inlineContent = "";
    for (let index = start; index < lines.length; index += 1) {
      const trimmed = lines[index].trim();
      if (!trimmed || /^```(?:ya?ml)?\s*$/iu.test(trimmed)) continue;
      const match = trimmed.match(/^["']?([a-z][a-z0-9_-]*)["']?\s*[:：]\s*(.*)$/iu);
      if (!match) break;
      const key = normalizedKey(match[1]);
      if (!STRUCTURED_TEXT_KEYS.has(key)) break;
      if (STRUCTURED_TEXT_PROTOCOL_KEYS.has(key)) sawProtocol = true;
      if (["content", "body", "documentbody", "documentcontent", "text"].includes(key)) {
        contentIndex = index;
        inlineContent = String(match[2] || "").replace(/^[>|][+-]?\s*$/u, "").trim();
        break;
      }
      artifact[key] = unquoteStructuredScalar(match[2]);
    }
      if (!sawProtocol || (contentIndex < 0 && !artifact.title && !artifact.documenttitle && !artifact.name)) continue;
      if (contentIndex < 0) {
        const normalizedTitleOnly = normalizedArtifact(artifact);
        if (valueText(normalizedTitleOnly.title)) return { artifacts: [normalizedTitleOnly], conversationSummary: "", warnings: [] };
        continue;
      }
    const remainder = lines.slice(contentIndex + 1);
    while (remainder.length && /^\s*(?:```|~~~)\s*$/u.test(remainder.at(-1))) remainder.pop();
    artifact.content = [inlineContent, ...remainder].filter((part, index) => index > 0 || part).join("\n").trim();
    const normalized = normalizedArtifact(artifact);
      if (valueText(normalized.content) || valueText(normalized.title)) return { artifacts: [normalized], conversationSummary: "", warnings: [] };
  }
  return null;
};

const normalizedArtifact = (artifact = {}) => ({
  artifactId: objectValue(artifact, "artifactId", "artifact_id", "id"),
  deliverableId: objectValue(artifact, "deliverableId", "deliverable_id"),
  title: objectValue(artifact, "title", "documentTitle", "document_name", "name"),
  content: objectValue(artifact, "content", "body", "documentBody", "document_content", "text"),
  contentType: objectValue(artifact, "contentType", "content_format", "contentFormat", "documentType", "type"),
  target: objectValue(artifact, "target"),
  sourceDocumentIds: objectValue(artifact, "sourceDocumentIds", "source_document_ids", "sources"),
  targetDocumentId: objectValue(artifact, "targetDocumentId", "target_document_id", "documentId", "document_id"),
  targetDirectoryId: objectValue(artifact, "targetDirectoryId", "target_directory_id", "directoryId", "directory_id"),
  operation: objectValue(artifact, "operation", "operationType", "operation_type", "action"),
  patches: objectValue(artifact, "patches", "edits", "changes"),
  memoryUpdate: objectValue(artifact, "memoryUpdate", "memory_update"),
  insertBeforeHeading: objectValue(artifact, "insertBeforeHeading", "insert_before_heading", "beforeHeading"),
  insertAfterHeading: objectValue(artifact, "insertAfterHeading", "insert_after_heading", "afterHeading"),
});

const MARKED_ARTIFACT_HEADER = /<!--\s*(?:deliverable(?:Id)?\s*[:=]\s*([^|>]+?)\s*\|\s*)?target(?:DocumentId)?\s*[:=]\s*([^|>]+?)(?:\s*\|\s*(?:type|kind|contentType)\s*[:=]\s*([^|>]+?))?\s*-->/giu;

const markedFormalEnvelope = (response = "") => {
  const source = valueText(response);
  const matches = [...source.matchAll(MARKED_ARTIFACT_HEADER)];
  if (!matches.length) return null;
  const artifacts = matches.map((match, index) => {
    const start = Number(match.index) + match[0].length;
    const end = Number(matches[index + 1]?.index ?? source.length);
    const rawContent = source.slice(start, end).trim();
    const firstLine = rawContent.split("\n").find((line) => line.trim())?.trim() || "";
    const title = firstLine.replace(/^#{1,6}\s*/u, "").trim();
    const targetDocumentId = valueText(match[2]);
    return {
      artifactId: `marked-${index + 1}`,
      deliverableId: valueText(match[1]) || targetDocumentId,
      targetDocumentId,
      contentType: valueText(match[3]) || "document",
      title: /^#{1,6}\s+/u.test(firstLine) ? title : "",
      content: rawContent,
      operation: "replace",
    };
  }).filter((artifact) => artifact.targetDocumentId && artifact.content);
  return artifacts.length ? { artifacts, conversationSummary: "", warnings: [] } : null;
};

const normalizedOperation = (value = "") => {
  const operation = normalizedKey(value);
  if (["replacedocumentbody", "replacebody", "replacedocument", "replacecontent", "documentreplacecontent", "overwrite", "replace"].includes(operation)) return "replace";
  if (["createdocument", "create", "newdocument"].includes(operation)) return "create";
  if (["appenddocumentbody", "appendbody", "appendcontent", "documentappendcontent", "append"].includes(operation)) return "append";
  if (["patchdocumentbody", "patchbody", "patchcontent", "documentpatchcontent", "patch", "update", "insert", "insertcontent", "documentinsertcontent"].includes(operation)) return "patch";
  return valueText(value);
};

const structuredEnvelope = (response = "") => {
  for (const source of structuredJsonSources(response)) {
    try {
      const parsed = JSON.parse(source);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const artifactList = objectValue(parsed, "artifacts", "documents", "outputs", "results");
      if (Array.isArray(artifactList)) return {
        artifacts: artifactList.map(normalizedArtifact),
        conversationSummary: objectValue(parsed, "conversationSummary", "conversation_summary", "summary"),
        warnings: objectValue(parsed, "warnings"),
      };
      const single = normalizedArtifact(parsed);
      if (valueText(single.content) || valueText(single.title)) return { artifacts: [single], conversationSummary: "", warnings: [] };
    } catch {
      // Continue trying fenced or embedded JSON candidates.
    }
  }
  return structuredTextEnvelope(response);
};

const SECTIONED_FORMAL_HEADING = /^(?:#{1,6}\s*)?(?:《[^》\r\n]{1,100}》\s*)?(参考资料|作品资料|正史设定|作品设定|世界观与基础规则|全书大纲|全集大纲|伏笔总表|伏笔管理|信息释放表|信息台阶)\s*$/u;

const sectionedFormalEnvelope = (response = "") => {
  const source = valueText(response);
  const lines = source.split("\n");
  const headings = lines.map((line, index) => {
    const match = line.trim().match(SECTIONED_FORMAL_HEADING);
    return match ? { index, label: match[1] } : null;
  }).filter(Boolean);
  if (headings.length < 2) return null;
  const artifacts = headings.map((heading, index) => {
    const nextIndex = headings[index + 1]?.index ?? lines.length;
    const content = lines.slice(heading.index + 1, nextIndex).join("\n").trim();
    const target = requestedArtifactTarget(heading.label);
    return {
      artifactId: `section-${index + 1}`,
      title: target?.title || heading.label,
      content,
      target,
      targetDocumentId: target?.documentId || "",
      operation: "replace",
    };
  }).filter((artifact) => artifact.content && artifact.targetDocumentId);
  return artifacts.length >= 2
    ? { artifacts, conversationSummary: "", warnings: [] }
    : null;
};

const INLINE_NON_DELIVERABLE = /(?:抱歉[^\n]{0,100}(?:不能|无法|不可以)[^\n]{0,80}(?:续写|创作|生成|改写)|我(?:不能|无法|不可以)(?:继续|直接|为你)?(?:续写|创作|生成|改写)|(?:先按|我会先)[^\n]{0,120}(?:创作构思流程|校准承接点)[^\n]{0,100}(?:再交付|再生成)|我(?:可以|会)立刻改写为原创[^\n]{0,120}(?:全新人物|新世界观))/iu;

export const formalArtifactContentAssessment = ({ content = "", instruction = "" } = {}) => {
  const cleaned = cleanFormalDocumentContent(content);
  if (!cleaned) return { valid: false, content: "", reason: "empty" };
  const nonEmptyLines = cleaned.split("\n").map((line) => line.trim()).filter(Boolean);
  if (nonEmptyLines.length <= 12 && BLOCKED_OR_DIAGNOSTIC_LEAD.test(nonEmptyLines[0] || "")) {
    return { valid: false, content: "", reason: "blocked_or_diagnostic_response" };
  }
  if (isAssistantOperationalText(cleaned) || INLINE_NON_DELIVERABLE.test(cleaned)) {
    return { valid: false, content: "", reason: "assistant_explanation_or_refusal" };
  }
  const continuation = /(?:续写|继续写|接着写|承接.{0,8}写)/u.test(valueText(instruction));
  if (continuation && cleaned.length < 40) return { valid: false, content: "", reason: "continuation_too_short" };
  return { valid: true, content: cleaned, reason: "formal_content" };
};

export const extractFormalArtifacts = ({ response = "", instruction = "", target = null, candidateCount = 1, technicalError = "", writeAuthorization = null, allowConfirmedNonFormal = false } = {}) => {
  const titleOnly = writeAuthorization?.state === "commit" && writeAuthorization?.action === "rename"
    && writeAuthorization?.allowTitleMutation === true && writeAuthorization?.allowBodyMutation !== true;
  const policy = formalArtifactLandingPolicy({ instruction, candidateCount, technicalError, writeAuthorization, candidate: response, target, contentType: target?.contentType || target?.contextDomain || "" });
  const envelope = structuredEnvelope(response) ?? markedFormalEnvelope(response) ?? sectionedFormalEnvelope(response);
  const rawArtifacts = envelope?.artifacts?.length
    ? envelope.artifacts
    : [{ content: titleOnly ? "" : response, title: titleOnly ? response : target?.title || "", target }];
  const artifacts = rawArtifacts.map((artifact, index) => {
    const sourceContent = removeMetaSections(artifact?.content ?? artifact?.body ?? "");
    const assessment = formalArtifactContentAssessment({
      content: sourceContent,
      instruction,
    });
    const confirmedContent = allowConfirmedNonFormal === true && !assessment.content
      ? cleanFormalDocumentContent(sourceContent)
      : assessment.content;
    const content = stripLeadingArtifactTitle(confirmedContent, artifact?.title);
    return {
      artifactId: valueText(artifact?.artifactId || artifact?.id) || `artifact-${index + 1}`,
      deliverableId: valueText(artifact?.deliverableId || artifact?.deliverable_id),
      title: valueText(artifact?.title || target?.title),
      content,
      contentType: valueText(artifact?.contentType || target?.contentType || "document"),
      target: artifact?.target && typeof artifact.target === "object" ? artifact.target : target,
      sourceDocumentIds: Array.isArray(artifact?.sourceDocumentIds) ? artifact.sourceDocumentIds.map(valueText).filter(Boolean) : [],
      targetDocumentId: valueText(artifact?.targetDocumentId || artifact?.target?.documentId || target?.documentId),
      targetDirectoryId: valueText(artifact?.targetDirectoryId || artifact?.target?.directoryId || target?.directoryId),
      operation: normalizedOperation(artifact?.operation),
      patches: Array.isArray(artifact?.patches) ? artifact.patches : [],
      memoryUpdate: artifact?.memoryUpdate && typeof artifact.memoryUpdate === "object" && !Array.isArray(artifact.memoryUpdate)
        ? artifact.memoryUpdate
        : null,
      insertBeforeHeading: valueText(artifact?.insertBeforeHeading),
      insertAfterHeading: valueText(artifact?.insertAfterHeading),
      contentAssessment: assessment.reason,
    };
  }).filter((artifact) => (artifact.content && (artifact.contentAssessment === "formal_content" || allowConfirmedNonFormal === true))
    || (titleOnly && artifact.title && !artifact.content));
  return {
    schema: "formal_artifact_result_v1",
    structuredResponse: Boolean(envelope),
    conversationSummary: valueText(envelope?.conversationSummary),
    artifacts,
    warnings: Array.isArray(envelope?.warnings) ? envelope.warnings.map(valueText).filter(Boolean) : [],
    landingPolicy: artifacts.length ? policy : { disposition: "technical_error", shouldLand: false, reason: "empty_formal_artifact" },
  };
};

export const extractFormalArtifactsWithRetry = async ({ retryExtractor = null, ...input } = {}) => {
  const first = extractFormalArtifacts(input);
  if (first.artifacts.length || typeof retryExtractor !== "function") return { ...first, extractionAttempts: 1 };
  const retriedResponse = await retryExtractor({
    response: valueText(input.response),
    instruction: valueText(input.instruction),
    directive: "只提取现有响应中的正式成果，不重新生成，不添加说明。",
  });
  const second = extractFormalArtifacts({ ...input, response: retriedResponse });
  return {
    ...second,
    extractionAttempts: 2,
    extractionError: second.artifacts.length ? "" : "FORMAL_ARTIFACT_EXTRACTION_FAILED",
    rawResponsePreserved: valueText(input.response),
  };
};

export const classifyDocumentWriteIntent = ({ instruction = "", targetExists = true, selectedText = "", artifactCount = 1 } = {}) => {
  const prompt = valueText(instruction);
  if (artifactCount > 1) return { operation: "batch", reason: "multiple_artifacts" };
  if (!targetExists || /(?:新建|创建|另建|新文档|新文件)/u.test(prompt)) return { operation: "create", reason: "new_target" };
  if (/(?:全文重写|整体重写|全部替换|完整重写|重新写一版完整正文|覆盖原文|覆盖全文)/u.test(prompt)) return { operation: "replace", reason: "explicit_full_replace" };
  if (contextualInsertionRequested(prompt)) return { operation: "insert", reason: "contextual_middle_insert" };
  if (selectedText || /(?:替换|改名|更名|把.{1,40}改成|将.{1,40}改为|局部修改|只改|仅改|第.{1,12}(?:段|场|章|节)|这(?:一)?段|这一句)/u.test(prompt)) {
    return { operation: "patch", reason: selectedText ? "selection" : "localized_edit" };
  }
  if (terminalContinuationRequested(prompt) || /(?:追加|附加到|写在末尾)/u.test(prompt)) return { operation: "append", reason: "explicit_append" };
  return { operation: "replace", reason: "formal_artifact_default" };
};

const sceneToken = (instruction = "") => valueText(instruction).match(/第\s*([一二三四五六七八九十百千万零〇两\d]+)\s*(场|幕|节|章|集)/u)?.slice(1, 3) ?? null;

export const semanticSectionPatch = ({ currentContent = "", candidate = "", instruction = "" } = {}) => {
  const current = valueText(currentContent);
  const replacement = valueText(candidate);
  const token = sceneToken(instruction);
  if (!current || !replacement || !token) return null;
  const escaped = token.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const heading = new RegExp(`(?:^|\\n)([^\\n]{0,60}第\\s*${escaped[0]}\\s*${escaped[1]}[^\\n]*)`, "u");
  const match = heading.exec(current);
  if (!match) return null;
  const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
  const afterStart = current.slice(start + match[1].length);
  const next = /\n[^\n]{0,60}第\s*[一二三四五六七八九十百千万零〇两\d]+\s*(?:场|幕|节|章|集)[^\n]*/u.exec(afterStart);
  const end = next ? start + match[1].length + next.index : current.length;
  const candidateHeading = heading.exec(replacement);
  const section = candidateHeading
    ? replacement.slice(candidateHeading.index + (candidateHeading[0].startsWith("\n") ? 1 : 0)).trim()
    : replacement;
  return {
    content: `${current.slice(0, start)}${section}${current.slice(end)}`.trim(),
    start,
    end,
    previous: current.slice(start, end),
    replacement: section,
  };
};
