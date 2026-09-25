import { createHash } from "node:crypto";
import {
  normalizeExperienceFacets,
  normalizeExperienceKind,
  normalizeExperienceProvenance,
  normalizeExperienceScope,
  normalizeTaskEnvelope,
} from "../experience-policy.js";

export const TRUSTED_CAPABILITY_CONTRACT_VERSION = 1;
export const MAX_ARTICLE_ILLUSTRATIONS = 8;

const textValue = (value, max = 4_000) => String(value ?? "").replace(/\0/g, "").trim().slice(0, max);
const list = (value) => Array.isArray(value) ? value : [];
const unique = (values) => [...new Set(values.filter(Boolean))];
const digest = (value) => createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
};

const articleStructure = (article = "") => {
  const source = textValue(article, 300_000);
  const lines = source.split(/\r?\n/);
  const headings = lines
    .map((line, lineIndex) => ({ lineIndex, text: line.replace(/^#{1,6}\s+/, "").trim(), marked: /^#{1,6}\s+/.test(line) }))
    .filter((item) => item.marked && item.text);
  const paragraphs = source.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  return { source, headings, paragraphs };
};

const normalizeAnchor = (value = {}, structure) => {
  const rawType = textValue(value?.type || value?.anchorType || "", 40).toLowerCase();
  const heading = textValue(value?.heading || value?.value || "", 240).replace(/^#{1,6}\s+/, "").trim();
  const excerpt = textValue(value?.excerpt || (rawType === "after_excerpt" ? value?.value : ""), 240);
  const paragraphIndex = Number(value?.paragraphIndex ?? (rawType === "after_paragraph" ? value?.value : NaN));
  if ((rawType === "after_heading" || (!rawType && heading)) && heading) {
    const match = structure.headings.find((item) => item.text === heading || item.text.includes(heading) || heading.includes(item.text));
    return match ? { type: "after_heading", heading: match.text, order: match.lineIndex } : null;
  }
  if ((rawType === "after_paragraph" || Number.isInteger(paragraphIndex)) && Number.isInteger(paragraphIndex)) {
    const normalizedIndex = paragraphIndex >= 1 ? paragraphIndex - 1 : paragraphIndex;
    return normalizedIndex >= 0 && normalizedIndex < structure.paragraphs.length
      ? { type: "after_paragraph", paragraphIndex: normalizedIndex, order: normalizedIndex }
      : null;
  }
  if ((rawType === "after_excerpt" || (!rawType && excerpt)) && excerpt && structure.source.includes(excerpt)) {
    return { type: "after_excerpt", excerpt, order: structure.source.indexOf(excerpt) };
  }
  return null;
};

export const normalizeIllustrationPlan = ({ article = "", value = {}, maxItems = MAX_ARTICLE_ILLUSTRATIONS } = {}) => {
  const structure = articleStructure(article);
  const sourceItems = list(value?.illustrations ?? value?.items ?? value?.plan);
  const issues = [];
  const normalized = [];
  const limit = Math.min(MAX_ARTICLE_ILLUSTRATIONS, Math.max(1, Number(maxItems) || MAX_ARTICLE_ILLUSTRATIONS));
  for (const [index, item] of sourceItems.slice(0, limit * 2).entries()) {
    const prompt = textValue(item?.prompt || item?.imagePrompt, 4_000);
    const purpose = textValue(item?.purpose || item?.use, 500);
    const anchor = normalizeAnchor(item?.anchor ?? item?.position ?? item, structure);
    if (!prompt || !purpose || !anchor) {
      issues.push(`配图项 ${index + 1} 缺少有效提示词、用途或正文锚点`);
      continue;
    }
    const aspectRatio = /^(?:1:1|4:3|3:4|16:9|9:16|3:2|2:3|21:9|9:21)$/.test(String(item?.aspectRatio || ""))
      ? String(item.aspectRatio)
      : "16:9";
    const idSeed = JSON.stringify(canonical({ anchor, purpose, prompt, aspectRatio }));
    normalized.push({
      id: `illustration:${digest(idSeed).slice(0, 20)}`,
      anchor,
      purpose,
      prompt,
      altText: textValue(item?.altText || purpose, 240),
      aspectRatio,
      order: anchor.order,
    });
  }
  const deduped = normalized
    .filter((item, index, values) => values.findIndex((candidate) => candidate.id === item.id || JSON.stringify(candidate.anchor) === JSON.stringify(item.anchor)) === index)
    .sort((left, right) => left.order - right.order)
    .slice(0, limit)
    .map(({ order, ...item }) => item);
  if (sourceItems.length > limit) issues.push(`配图数量超过单轮上限 ${limit}，超出部分未进入可信动作`);
  if (!structure.source) issues.push("正文为空，不能建立配图锚点");
  if (!deduped.length && sourceItems.length) issues.push("没有配图项通过结构化契约校验");
  const plan = {
    schemaVersion: TRUSTED_CAPABILITY_CONTRACT_VERSION,
    contract: "illustration_plan_v1",
    articleHash: digest(structure.source),
    items: deduped,
  };
  return { valid: Boolean(structure.source && deduped.length), plan, issues: unique(issues).slice(0, 24) };
};

const normalizeAtomicExperienceCandidate = ({ artifact = "", value = {}, task = {}, envelope = {} } = {}) => {
  const source = textValue(artifact, 300_000);
  const evidence = list(value?.evidence).map((item) => ({
    claim: textValue(item?.claim, 500),
    quote: textValue(item?.quote, 800),
  })).filter((item) => item.claim && item.quote && source.includes(item.quote)).slice(0, 8);
  const observation = textValue(value?.observation || value?.pattern, 1_200);
  const recommendation = textValue(value?.recommendation || value?.rule, 1_200);
  const lane = textValue(value?.lane || value?.track || task?.lane || "general", 120) || "general";
  const deliverableType = textValue(value?.deliverableType || task?.deliverableType || "", 80);
  const contextDomain = textValue(value?.contextDomain || task?.contextDomain || "general", 80) || "general";
  const confidence = ["low", "medium", "high"].includes(value?.confidence) ? value.confidence : "medium";
  const kind = normalizeExperienceKind(value?.kind);
  const title = textValue(value?.title || observation, 160);
  const facets = normalizeExperienceFacets(value?.facets, {
    topics: value?.topics ?? value?.tags,
    stages: value?.stages,
    capabilities: value?.capabilities,
    deliverableType,
    contextDomain,
    taskType: task?.taskType,
  });
  const conditions = unique(list(value?.conditions).map((item) => textValue(item, 500))).slice(0, 16);
  const exclusions = unique(list(value?.exclusions).map((item) => textValue(item, 500))).slice(0, 16);
  const scopeProposal = normalizeExperienceScope(value?.scopeProposal ?? value?.scope, {
    fallbackLevel: "project",
    fallbackScopeId: envelope?.projectId,
    fallbackLabel: "当前作品",
    needsReview: !envelope?.projectId,
  });
  const provenance = normalizeExperienceProvenance(value?.provenance, envelope);
  const issues = [];
  if (!source) issues.push("成品为空，不能沉淀经验");
  if (!title || !observation || !recommendation) issues.push("经验候选缺少标题、观察或可复用建议");
  if (!evidence.length) issues.push("经验候选没有可在成品中核验的证据");
  if (!facets.stages.length || !facets.capabilities.length) issues.push("经验候选缺少可解释的阶段或能力分类");
  const candidateBody = {
    title, kind, facets, lane, deliverableType, contextDomain, observation, recommendation,
    conditions, exclusions, scopeProposal, evidence, provenance, confidence,
  };
  return {
    valid: Boolean(source && title && observation && recommendation && evidence.length && facets.stages.length && facets.capabilities.length),
    candidate: {
      schemaVersion: 3,
      contract: "experience_candidate_v3",
      artifactHash: digest(source),
      fingerprint: digest(JSON.stringify(canonical(candidateBody))),
      ...candidateBody,
    },
    issues,
  };
};

export const normalizeExperienceCandidateBatch = ({ artifact = "", value = {}, task = {}, taskEnvelope = {} } = {}) => {
  const envelope = normalizeTaskEnvelope(taskEnvelope, task);
  const sourceItems = list(value?.candidates ?? value?.items ?? (value?.contract === "experience_candidate_batch_v3" ? [] : [value]));
  const candidates = [];
  const issues = [];
  for (const [index, item] of sourceItems.slice(0, 12).entries()) {
    const normalized = normalizeAtomicExperienceCandidate({ artifact, value: item, task, envelope });
    if (normalized.valid) candidates.push(normalized.candidate);
    else issues.push(...normalized.issues.map((issue) => `候选 ${index + 1}：${issue}`));
  }
  const deduped = candidates.filter((item, index, values) => values.findIndex((candidate) => candidate.fingerprint === item.fingerprint) === index);
  return {
    valid: Boolean(textValue(artifact, 300_000)) && (deduped.length > 0 || sourceItems.length === 0),
    batch: {
      schemaVersion: 3,
      contract: "experience_candidate_batch_v3",
      taskEnvelope: envelope,
      candidates: deduped,
    },
    issues: unique(issues).slice(0, 48),
  };
};

export const normalizeExperienceCandidate = ({ artifact = "", value = {}, task = {}, taskEnvelope = {} } = {}) => {
  const normalized = normalizeExperienceCandidateBatch({ artifact, value, task, taskEnvelope });
  return {
    valid: normalized.valid && normalized.batch.candidates.length === 1,
    candidate: normalized.batch.candidates[0] ?? null,
    issues: normalized.batch.candidates.length > 1 ? [...normalized.issues, "单候选兼容入口收到多条经验"] : normalized.issues,
  };
};

export const validateTrustedActionRequest = ({ action = "", input = {}, context = {} } = {}) => {
  if (action === "enqueue_image_generation") {
    const result = normalizeIllustrationPlan({ article: context.artifact, value: input, maxItems: context.maxItems });
    return { ...result, action, input: result.plan };
  }
  if (action === "submit_experience_candidate") {
    const result = normalizeExperienceCandidate({ artifact: context.artifact, value: input, task: context.task, taskEnvelope: context.taskEnvelope });
    return { ...result, action, input: result.candidate };
  }
  if (action === "submit_experience_candidate_batch") {
    const result = normalizeExperienceCandidateBatch({ artifact: context.artifact, value: input, task: context.task, taskEnvelope: context.taskEnvelope });
    return { ...result, action, input: result.batch };
  }
  return { valid: false, action, input: null, issues: [`不受信任或未注册的动作：${textValue(action, 120) || "空动作"}`] };
};
