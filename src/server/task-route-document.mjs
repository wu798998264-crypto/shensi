import { createHash } from "node:crypto";

export const TASK_ROUTE_GENERATION_TIMEOUT_MS = 20_000;

const text = (value, limit = 20_000) => String(value ?? "").trim().slice(0, limit);
const list = (value) => Array.isArray(value) ? value : [];
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");

const relationLabel = (relationType = "parallel") => relationType === "primary-secondary"
  ? "主次"
  : relationType === "organization" ? "组织" : "并行";

const memberSummary = (member = {}, index = 0) => ({
  id: text(member.targetId || member.id, 180),
  type: text(member.targetType || member.nodeType || "slot", 40),
  role: text(member.role || (index === 0 ? "first" : "member"), 40),
});

export const compactCapabilityRouteTopology = ({ bundle = {}, routeRevision = 0, topologyHash = "" } = {}) => ({
  routeRevision: Math.max(0, Number(routeRevision) || 0),
  topologyHash: text(topologyHash, 128).toLowerCase(),
  template: bundle?.template ? {
    id: text(bundle.template.id, 180),
    name: text(bundle.template.name, 160),
    relation: relationLabel(bundle.template.relationType),
    members: list(bundle.template.items).map(memberSummary),
  } : null,
  groups: list(bundle?.groups).map((group) => ({
    id: text(group.id, 180),
    name: text(group.name, 160),
    description: text(group.description, 360),
    relation: relationLabel(group.relationType),
    members: list(group.items).map(memberSummary),
  })),
  modules: list(bundle?.modules).map((module) => ({
    id: text(module.id, 180),
    name: text(module.name, 160),
    description: text(module.description, 360),
    relation: relationLabel(module.relationType),
    slots: list(module.slots).map((slot, index) => ({
      id: text(slot.id, 180),
      name: text(slot.name, 160),
      role: text(slot.role || (index === 0 && module.relationType === "primary-secondary" ? "primary" : index === 0 && module.relationType === "organization" ? "upper" : "peer"), 40),
      skillId: text(slot.skillId, 180),
      capabilities: list(slot.capabilities).map((item) => text(item, 120)).filter(Boolean),
      triggerConditions: list(slot.triggerConditions).map((item) => text(item, 240)).filter(Boolean),
    })),
  })),
});

export const taskRouteDocumentGenerationPrompt = ({ bundle, routeRevision, topologyHash } = {}) => ({
  system: [
    "你只负责把当前 Skill 面板拓扑整理成一份简短、可执行的 Agent 动态路由附录，不执行任何 Skill，也不修改面板。",
    "只输出一个 JSON 对象，字段必须是 routeRevision、topologyHash、document。前两个字段原样复制输入；document 使用中文 Markdown。",
    "document 应说明各模组、模块、插槽的职责和真实关系。并行成员按任务需要独立或协作；主次关系优先第一位但允许按完整语义选择次要项；组织关系由第一位组织下位项。",
    "路由只能依据完整意图、阶段、交付物、上下文和实时能力，不得编造关键词命中表、必读清单、固定步骤、主笔人选或主笔数量问答。",
    "不要提及旧路由文件名。不要复制输入 JSON，不要输出代码围栏。正文控制在 4000 中文字以内。",
  ].join("\n"),
  messages: [{
    role: "user",
    content: JSON.stringify(compactCapabilityRouteTopology({ bundle, routeRevision, topologyHash })),
  }],
});

export const parseTaskRouteDocumentCandidate = (raw = "") => {
  const source = text(raw, 80_000).replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回任务路由 JSON");
  let parsed;
  try {
    parsed = JSON.parse(source.slice(start, end + 1));
  } catch {
    throw new Error("模型返回的任务路由 JSON 无法解析");
  }
  return {
    routeRevision: Math.max(0, Number(parsed?.routeRevision) || 0),
    topologyHash: text(parsed?.topologyHash, 128).toLowerCase(),
    document: text(parsed?.document, 20_000),
  };
};

const obsoleteRoutePattern = /(?:任务路由模块|神思-任务路由规则|神思-执行入口映射表)/u;
const mainWriterWizardPattern = /(?:(?:谁|哪个|哪位|几个|多少(?:个)?)\s*(?:来|作为|担任|当)?\s*主笔|主笔\s*(?:人数|数量|人选))/u;
const keywordDecisionPattern = /(?:(?:命中|出现|包含)\s*[^。；\n]{0,18}关键词\s*[^。；\n]{0,18}(?:调用|选择|启用|路由)|关键词\s*[^。；\n]{0,12}(?:决定|绑定|裁决)\s*[^。；\n]{0,18}(?:任务|Skill|能力|路由))/u;

export const validateTaskRouteDocumentCandidate = (candidate = {}, { routeRevision = 0, topologyHash = "", bundle = {} } = {}) => {
  const errors = [];
  const document = text(candidate.document, 20_000);
  const expectedRevision = Math.max(0, Number(routeRevision) || 0);
  const expectedHash = text(topologyHash, 128).toLowerCase();
  if (Math.max(0, Number(candidate.routeRevision) || 0) !== expectedRevision) errors.push("路由版本在生成期间已经变化");
  if (!expectedHash || text(candidate.topologyHash, 128).toLowerCase() !== expectedHash) errors.push("拓扑哈希与当前面板不一致");
  if (document.length < 80) errors.push("动态路由正文过短");
  if (document.length > 12_000) errors.push("动态路由正文超过 12000 字符");
  if (obsoleteRoutePattern.test(document)) errors.push("动态路由引用了已经废弃的旧文件");
  if (mainWriterWizardPattern.test(document)) errors.push("动态路由重新引入了主笔人选或数量向导");
  if (keywordDecisionPattern.test(document)) errors.push("动态路由重新引入了关键词裁决");
  const relations = new Set([
    bundle?.template?.relationType,
    ...list(bundle?.groups).map((item) => item.relationType),
    ...list(bundle?.modules).map((item) => item.relationType),
  ]);
  if (relations.has("parallel") && !document.includes("并行")) errors.push("动态路由缺少并行关系语义");
  if (relations.has("primary-secondary") && !document.includes("主次")) errors.push("动态路由缺少主次关系语义");
  if (relations.has("organization") && !document.includes("组织")) errors.push("动态路由缺少组织关系语义");
  return {
    valid: errors.length === 0,
    errors,
    document,
    contentHash: document ? hash(document) : "",
  };
};

export const taskRouteDocumentModelSnapshot = (settings = {}) => ({
  profileId: text(settings.id || settings.connectionId || settings.activeTextAgentConnectionId || settings.activeTextConnectionId, 180),
  provider: text(settings.provider, 120),
  model: text(settings.agentModelId || settings.model, 180),
  agentEngine: text(settings.agentEngine, 80),
  adapter: text(settings.adapter, 40),
});
