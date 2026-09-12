import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  allowedSkillCapabilities,
  normalizeSkillMetadata,
  parseSkillMarkdown,
  skillHasPrimaryCapability,
  validateSkillMetadata,
} from "../skill-contract.js";
import { scanSkillSource, skillTestSummary } from "../skill-security.js";
import { persistentSkillsRoot } from "./app-data.mjs";
import {
  BUILTIN_SKILL_CATALOG,
  DEFAULT_CUSTOM_SKILL_SLOTS,
  FIXED_SKILL_SLOT_CATALOG,
  FIXED_SKILL_SLOT_CHAINS,
  FIXED_SKILL_SLOT_GROUPS,
  canonicalBuiltinSkillId,
} from "../module-registry.js";
import { matchSkillTrigger, validateTriggerDeclaration } from "../skill-trigger.js";
import { explicitSecondaryIndexForSlot } from "../fixed-slot-bindings.js";
import { CAPABILITY_DESCRIPTOR_SCHEMA_VERSION } from "../capability-registry.js";
import {
  CAPABILITY_TEMPLATE_SCHEMA_VERSION,
  applyCapabilityKernelMechanisms,
  capabilityKernelMutationErrors,
  capabilityTemplateNode,
  capabilityTemplateTopology,
  createInitialCapabilityTemplate,
  lintCapabilityTemplateReachability,
  migrateLegacySlotsIntoCapabilityTemplate,
  normalizeCapabilityTemplate,
  pruneCapabilityTemplateEmptySlots,
  resolveCapabilityTemplateRouting,
  validateCapabilityTemplate,
} from "../capability-template.js";
import { BUNDLED_CUSTOM_SKILLS, BUNDLED_CUSTOM_SKILL_SEED_VERSION, STYLE_DISTILLATION_SKILL } from "./bundled-custom-skills.mjs";
import { unzipSelectedEntries } from "./document-extraction.mjs";
import { zipStore } from "./docx-export.mjs";
import { assertRemoteMarketplaceSkillIdentity, downloadRemoteMarketplaceArtifact, readRemoteMarketplace } from "./marketplace-client.mjs";
import { applyLocalPublisherAuthority, publisherFields, readLocalPublisherAuthority } from "./publisher-authority.mjs";
import { loadWritingSkillRuleSources } from "./writing-style-skill-cache.mjs";
import {
  COMPOSITE_RELATION_INFERENCE_VERSION,
  COMPOSITE_RELATION_SCHEMA_VERSION,
  analyzeCompositeRelationScope,
  compositeManifestRelations,
  compositeRelationAnalysisSummary,
  compositeTopologyHash,
} from "./composite-relation-inference.mjs";
import { validateTaskRouteDocumentCandidate } from "./task-route-document.mjs";

const REGISTRY_SCHEMA_VERSION = 19;
const MAX_SKILL_SOURCE_BYTES = 256 * 1024;
const MAX_SKILL_PACKAGE_BYTES = 4 * 1024 * 1024;
const MAX_CAPABILITY_ASSET_BYTES = 2 * 1024 * 1024;
const SKILL_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SLOT_GROUP_TYPES = new Set(["parallel", "organization"]);
const USER_DIRECTORY = "user";
const SKILL_TRASH_DIRECTORY = "recycle-bin";
const BUNDLED_CUSTOM_SKILL_MARKER = ".bundled-custom-skills.json";
const CAPABILITY_ASSET_TYPES = new Set(["module", "group", "template"]);
const MARKETPLACE_ASSET_TYPES = new Set(["skill", ...CAPABILITY_ASSET_TYPES]);
const CAPABILITY_ASSET_PACKAGE_FORMAT = "shensi-capability-package-v1";
const CAPABILITY_ASSET_HISTORY_LIMIT = 30;
const COMPOSITE_SKILL_PROCESSOR = Object.freeze({
  id: "builtin:composite-skill-structure-importer",
  name: "复合 Skill 结构转换",
  version: "2.0.0",
  description: "识别完整 Skill 包中的总控与子 Skill，保留原始层级和关系，并转换为可预览的模块或模组。",
});
const SKILL_TRUST_LEVELS = Object.freeze([
  { id: "official", label: "官方", description: "由神思团队维护并随官方目录发布。" },
  { id: "verified", label: "已验证", description: "由软件完成静态检查、合同检查与隔离沙箱测试。" },
  { id: "community", label: "社区", description: "由软件完成静态安全与合同检查，尚未完成隔离沙箱测试。" },
  { id: "local", label: "本地", description: "用户在本机创建或导入，未公开验证。" },
]);
const SKILL_SOURCE_TYPES = Object.freeze([
  { id: "github", label: "GitHub" },
  { id: "gitee", label: "Gitee" },
  { id: "local_folder", label: "本地文件夹" },
  { id: "private_repository", label: "私有仓库" },
  { id: "team_server", label: "团队服务器" },
]);
const OFFICIAL_MARKETPLACE_SKILLS = Object.freeze([
  {
    id: "official:bestseller-ranking-scan",
    skillId: "builtin:bestseller-ranking-scan",
    managedSkillId: "shensi.bestseller-ranking-scan",
    name: "爆款扫榜",
    author: "神思团队",
    version: "1.0.0",
    description: "由 Agent 通过内置只读浏览器采集公开榜单原页，形成可追溯的非正史市场观察报告。",
    trustLevel: "official",
    sourceType: "official",
    sourceLabel: "神思官方目录",
    capabilities: ["market_research", "ranking_scan", "knowledge_reference"],
    workspaceModes: ["general"],
    preinstalled: true,
    bundled: true,
    slotId: "bestseller-ranking-scan",
    popularity: 960,
    publishedAt: Date.UTC(2026, 7, 21),
  },
  {
    id: "official:book-deconstruction",
    skillId: "builtin:book-deconstruction",
    managedSkillId: "shensi.book-deconstruction",
    name: "爆款拆书",
    author: "神思团队",
    version: "1.0.0",
    description: "对本轮授权的完整作品或指定范围进行连续、可审计的爆款机制逆向拆解。",
    trustLevel: "official",
    sourceType: "official",
    sourceLabel: "神思官方目录",
    capabilities: ["knowledge_reference"],
    workspaceModes: ["general"],
    preinstalled: true,
    bundled: true,
    slotId: "book-deconstruction",
    popularity: 980,
    publishedAt: Date.UTC(2026, 5, 18),
  },
  {
    id: "official:style-distillation",
    skillId: "shensi.style-distillation",
    name: "文风蒸馏",
    author: "神思团队",
    version: STYLE_DISTILLATION_SKILL.version,
    description: "从本轮授权文本中提炼文风档案，或把既有文风档案作为辅助写作约束使用。",
    trustLevel: "official",
    sourceType: "official",
    sourceLabel: "神思官方目录",
    capabilities: ["style_reference"],
    workspaceModes: ["general"],
    installed: false,
    bundled: true,
    installContent: STYLE_DISTILLATION_SKILL.content,
    popularity: 760,
    publishedAt: Date.UTC(2026, 6, 16),
  },
  {
    id: "official:novel-cover-design",
    skillId: "shensi.novel-cover-design",
    managedSkillId: "shensi.novel-cover-design",
    name: "小说封面设计",
    author: "神思团队",
    version: "1.0.0",
    description: "建立小说封面设计合同、文字安全区、标题与作者名排版验证、三个成品方向和封面历史资产标注。",
    trustLevel: "official",
    sourceType: "official",
    sourceLabel: "神思官方目录",
    capabilities: ["novel_cover_designer"],
    workspaceModes: ["project", "notebook", "general"],
    preinstalled: true,
    bundled: true,
    popularity: 820,
    publishedAt: Date.UTC(2026, 6, 27),
  },
]);
const MARKETPLACE_CONTENT_SOURCES = Object.freeze({
  "official:bestseller-ranking-scan": "bestseller-ranking-scan/SKILL.md",
  "official:book-deconstruction": "bestseller-book-deconstruction/SKILL.md",
  "official:novel-cover-design": "novel-cover-design/SKILL.md",
});
const registryReadCache = new Map();
const skillVersionReadCache = new Map();
const managedCatalogInFlight = new Map();
const skillStoreCacheMetrics = {
  registryHits: 0,
  registryMisses: 0,
  versionHits: 0,
  versionMisses: 0,
  catalogJoins: 0,
};
const REGISTRY_LOCK_STALE_MS = 60_000;
const REGISTRY_LOCK_WAIT_MS = 10_000;

const BUILTIN_SKILLS = BUILTIN_SKILL_CATALOG;

const hashText = (value) => createHash("sha256").update(String(value)).digest("hex");
const hashBytes = (value) => createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(value || [])).digest("hex");
const yamlString = (value = "") => JSON.stringify(String(value ?? ""));
const yamlList = (values = []) => (values ?? []).length
  ? `\n${values.map((value) => `  - ${yamlString(value)}`).join("\n")}`
  : " []";
const unique = (values = []) => [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
const registryFile = (root) => join(root, "registry.json");
const registryPreviousFile = (root) => `${registryFile(root)}.previous`;
const SKILL_ORIGINS = new Set(["created", "imported", "downloaded"]);
const normalizedOrigin = (value) => value === "market" ? "downloaded"
  : value === "user" ? "created"
    : SKILL_ORIGINS.has(value) ? value : "imported";
const normalizedTrustLevel = (value, origin = "imported") => {
  if (value === "official") return "official";
  if (value === "verified" && normalizedOrigin(origin) === "downloaded") return "verified";
  if (value === "community" && normalizedOrigin(origin) === "downloaded") return "community";
  return "local";
};
const installTrustLevel = (origin = "imported") => normalizedOrigin(origin) === "downloaded" ? "community" : "local";
const inferredSourceType = (value = "", origin = "imported") => {
  const source = String(value).trim();
  if (/github\.com/i.test(source)) return "github";
  if (/gitee\.com/i.test(source)) return "gitee";
  if (/^(?:private|ssh):/i.test(source)) return "private_repository";
  if (/^https?:\/\//i.test(source)) return "team_server";
  return normalizedOrigin(origin) === "downloaded" ? "team_server" : "local_folder";
};
const compactSkillName = (value = "") => String(value || "")
  .normalize("NFKC")
  .replace(/[\s·_\-—()（）【】\[\]]+/gu, "")
  .toLocaleLowerCase("zh-CN");
const deprecatedPersonalSkillEntry = (entry = {}) => {
  const name = compactSkillName(entry.name);
  if (String(entry.id || "").trim() === "ai-video-director" || name === "ai视频导演") return true;
  if (["正文主笔副本", "小说正文主笔副本"].includes(name)) return true;
  return /^2\.5视频提示词(?:副本|本地版|自定义版)?$/u.test(name);
};
const isInside = (candidate, parent) => {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const atomicWrite = async (target, content) => {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(content, Buffer.isBuffer(content) ? undefined : "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error.code)) {
      await rm(temporary, { force: true });
      throw error;
    }
    const displaced = `${target}.${process.pid}.${randomUUID()}.replaced`;
    await rename(target, displaced);
    try {
      await rename(temporary, target);
    } catch (replacementError) {
      await rename(displaced, target).catch(() => {});
      await rm(temporary, { force: true });
      throw replacementError;
    }
    await rm(displaced, { force: true });
  }
};

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const renameWithTransientRetry = async (sourcePath, targetPath, { attempts = 6 } = {}) => {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(sourcePath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      if (!TRANSIENT_RENAME_CODES.has(error?.code) || attempt === attempts - 1) throw error;
      await wait(40 * (2 ** attempt));
    }
  }
  throw lastError;
};

const withRegistryLock = async (root, action) => {
  const lockPath = `${registryFile(root)}.lock`;
  const startedAt = Date.now();
  await mkdir(dirname(lockPath), { recursive: true });
  while (true) {
    let handle;
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8");
      await handle.sync();
      try {
        return await action();
      } finally {
        await handle.close().catch(() => {});
        await rm(lockPath, { force: true }).catch(() => {});
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error.code !== "EEXIST") throw error;
      const lockMetadata = await stat(lockPath).catch(() => null);
      if (lockMetadata && Date.now() - lockMetadata.mtimeMs > REGISTRY_LOCK_STALE_MS) {
        await rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() - startedAt >= REGISTRY_LOCK_WAIT_MS) {
        const timeout = new Error("Skill 注册表正被另一个进程更新，请稍后重试");
        timeout.code = "SKILL_REGISTRY_LOCK_TIMEOUT";
        timeout.statusCode = 409;
        throw timeout;
      }
      await wait(25 + Math.floor(Math.random() * 50));
    }
  }
};

const FIXED_GROUP_IDS = new Set(FIXED_SKILL_SLOT_GROUPS.map((group) => group.id));
const fixedGroupById = new Map(FIXED_SKILL_SLOT_GROUPS.map((group) => [group.id, group]));
const GUIDANCE_CAPABILITIES = new Set(["creative_guidance", "novel_guidance", "short_drama_guidance", "public_account_guidance", "short_fiction_guidance", "short_video_guidance", "prompt_guidance"]);
const PRIMARY_WRITER_SLOT_CAPABILITIES = new Set(["novel_prose_writer", "original_script_writer", "adaptation_writer", "visual_prompt_writer", "public_account_writer", "short_fiction_writer", "short_video_script_writer", "prompt_writer", "custom_writer"]);
const REVIEW_CAPABILITIES = new Set(["effect_reviewer", "genre_reviewer", "format_extension"]);

const inferredParentGroupId = (slot = {}) => {
  const capabilities = new Set(slot.capabilities ?? []);
  if (capabilities.has("theory_advisor") && capabilities.has("short_video_script_writer")) return "group:short-video-theory";
  if ([...capabilities].some((capability) => GUIDANCE_CAPABILITIES.has(capability))) return "group:creative-guidance";
  // Writer placement is now owned by the authoritative capability template.
  // Keeping a legacy fixed parent here would recreate the removed “主笔” group.
  if (capabilities.has("theory_advisor")) return "group:novel-script-theory";
  if ([...capabilities].some((capability) => REVIEW_CAPABILITIES.has(capability))) return "group:effect-review";
  return "";
};

const defaultCustomSlots = () => DEFAULT_CUSTOM_SKILL_SLOTS.map((slot) => ({
  ...slot,
  workspaceModes: [...slot.workspaceModes],
  capabilities: [...slot.capabilities],
  triggerKeywords: [...(slot.triggerKeywords ?? [])],
  triggerConditions: [...(slot.triggerConditions ?? [])],
  createdAt: 0,
  updatedAt: 0,
}));

const TEMPLATE_HISTORY_LIMIT = 50;
const ROUTE_DOCUMENT_HISTORY_LIMIT = 50;

const normalizeRouteDocumentModel = (value = {}) => ({
  profileId: String(value?.profileId || "").trim().slice(0, 180),
  provider: String(value?.provider || "").trim().slice(0, 120),
  model: String(value?.model || "").trim().slice(0, 180),
  agentEngine: String(value?.agentEngine || "").trim().slice(0, 80),
  adapter: String(value?.adapter || "").trim().slice(0, 40),
});

const normalizeRouteDocumentRecord = (value = {}) => {
  const createdAt = Number(value.createdAt) || Date.parse(value.createdAtIso || "") || Date.now();
  const status = value.status === "accepted" ? "accepted" : "rejected";
  const content = status === "accepted" ? String(value.content || "").trim().slice(0, 20_000) : "";
  return {
    id: String(value.id || `route-document:${randomUUID()}`).slice(0, 220),
    status,
    routeRevision: Math.max(0, Number(value.routeRevision) || 0),
    topologyHash: /^[a-f0-9]{64}$/iu.test(String(value.topologyHash || "")) ? String(value.topologyHash).toLowerCase() : "",
    content,
    contentHash: content ? hashText(content) : String(value.contentHash || "").slice(0, 128),
    model: normalizeRouteDocumentModel(value.model),
    message: String(value.message || "").trim().slice(0, 1_000),
    errors: (Array.isArray(value.errors) ? value.errors : []).map((item) => String(item || "").trim().slice(0, 500)).filter(Boolean).slice(0, 20),
    sourceRecordId: String(value.sourceRecordId || "").trim().slice(0, 220),
    createdAt,
    createdAtIso: new Date(createdAt).toISOString(),
  };
};

const normalizeRouteDocumentState = (value = {}) => {
  const history = (Array.isArray(value?.history) ? value.history : [])
    .map(normalizeRouteDocumentRecord)
    .slice(-ROUTE_DOCUMENT_HISTORY_LIMIT);
  const requestedCurrentId = String(value?.currentId || value?.current?.id || "").trim();
  const current = history.find((entry) => entry.id === requestedCurrentId && entry.status === "accepted")
    || [...history].reverse().find((entry) => entry.status === "accepted")
    || null;
  return { schemaVersion: 1, currentId: current?.id || "", history };
};

const publicRouteDocumentRecord = ({ content: _content, ...record } = {}) => record;
const publicRouteDocumentState = (value = {}) => {
  const state = normalizeRouteDocumentState(value);
  return {
    schemaVersion: state.schemaVersion,
    current: state.history.find((entry) => entry.id === state.currentId) ? publicRouteDocumentRecord(state.history.find((entry) => entry.id === state.currentId)) : null,
    history: [...state.history].reverse().map(publicRouteDocumentRecord),
  };
};

const capabilityTemplateHistoryRecord = ({
  scopeType,
  scopeId,
  version,
  snapshot,
  reason = "saved",
  createdAt = Date.now(),
  routeRevision = 0,
  topologyHash = "",
  routingAudit = null,
  routeDiff = null,
  routeSnapshot = null,
  sourceScopeType = scopeType,
  sourceScopeId = scopeId,
  restoredFromRouteRevision = 0,
  dynamicRoute = null,
}) => ({
  id: `template-version:${scopeType}:${String(scopeId).replace(/[^a-z0-9._:-]/gi, "-")}:${version}:${randomUUID()}`,
  scopeType,
  scopeId,
  version,
  reason,
  createdAt,
  createdAtIso: new Date(createdAt).toISOString(),
  snapshot: structuredClone(snapshot),
  routeRevision: Math.max(0, Number(routeRevision) || 0),
  topologyHash: /^[a-f0-9]{64}$/i.test(String(topologyHash || "")) ? String(topologyHash).toLowerCase() : "",
  routingAudit: routingAudit && typeof routingAudit === "object" ? structuredClone(routingAudit) : null,
  routeDiff: routeDiff && typeof routeDiff === "object" ? structuredClone(routeDiff) : null,
  routeSnapshot: routeSnapshot && typeof routeSnapshot === "object" ? structuredClone(routeSnapshot) : null,
  sourceScopeType: ["template", "group", "module", "slot", "slot-group", "skill", "route"].includes(sourceScopeType) ? sourceScopeType : scopeType,
  sourceScopeId: String(sourceScopeId || scopeId || "").slice(0, 180),
  restoredFromRouteRevision: Math.max(0, Number(restoredFromRouteRevision) || 0),
  dynamicRoute: dynamicRoute && typeof dynamicRoute === "object" ? structuredClone(dynamicRoute) : null,
});

const createInitialCapabilityTemplateState = ({ customSlots = [], customSlotGroups = [] } = {}) => {
  const current = migrateLegacySlotsIntoCapabilityTemplate(createInitialCapabilityTemplate(), { customSlots, customSlotGroups });
  const createdAt = Date.now();
  const history = {
    template: [capabilityTemplateHistoryRecord({ scopeType: "template", scopeId: current.template.id, version: 1, snapshot: current, reason: "initial", createdAt })],
    groups: Object.fromEntries(current.groups.map((group) => [group.id, [capabilityTemplateHistoryRecord({ scopeType: "group", scopeId: group.id, version: 1, snapshot: group, reason: "initial", createdAt })]])),
    modules: Object.fromEntries(current.modules.map((module) => [module.id, [capabilityTemplateHistoryRecord({ scopeType: "module", scopeId: module.id, version: 1, snapshot: module, reason: "initial", createdAt })]])),
  };
  return { schemaVersion: CAPABILITY_TEMPLATE_SCHEMA_VERSION, current, history, initializedAt: createdAt, updatedAt: createdAt };
};

const normalizedTemplateHistoryEntries = (entries, { scopeType, scopeId, fallbackSnapshot }) => {
  const normalized = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && Number(entry.version) > 0 && entry.snapshot)
    .map((entry) => {
      const createdAt = Number(entry.createdAt) || Date.parse(entry.createdAtIso || "") || Date.now();
      const snapshot = scopeType === "template"
        ? normalizeCapabilityTemplate(entry.snapshot)
        : { ...entry.snapshot, nodeType: scopeType };
      return {
        id: String(entry.id || `template-version:${scopeType}:${scopeId}:${entry.version}:${randomUUID()}`),
        scopeType,
        scopeId,
        version: Math.max(1, Number(entry.version) || 1),
        reason: ["initial", "saved", "restored", "reset", "activated", "route_changed", "slot_saved", "slot_enabled", "slot_disabled", "slot_deleted", "slot_group_saved", "slot_group_deleted", "skill_changed", "route_refreshed"].includes(entry.reason) ? entry.reason : "saved",
        createdAt,
        createdAtIso: new Date(createdAt).toISOString(),
        snapshot,
        routeRevision: Math.max(0, Number(entry.routeRevision) || 0),
        topologyHash: /^[a-f0-9]{64}$/i.test(String(entry.topologyHash || "")) ? String(entry.topologyHash).toLowerCase() : "",
        routingAudit: entry.routingAudit && typeof entry.routingAudit === "object" ? structuredClone(entry.routingAudit) : null,
        routeDiff: entry.routeDiff && typeof entry.routeDiff === "object" ? structuredClone(entry.routeDiff) : null,
        routeSnapshot: entry.routeSnapshot && typeof entry.routeSnapshot === "object" ? structuredClone(entry.routeSnapshot) : null,
        sourceScopeType: ["template", "group", "module", "slot", "slot-group", "skill", "route"].includes(entry.sourceScopeType) ? entry.sourceScopeType : scopeType,
        sourceScopeId: String(entry.sourceScopeId || scopeId || "").slice(0, 180),
        restoredFromRouteRevision: Math.max(0, Number(entry.restoredFromRouteRevision) || 0),
        dynamicRoute: entry.dynamicRoute && typeof entry.dynamicRoute === "object" ? structuredClone(entry.dynamicRoute) : null,
      };
    })
    .sort((left, right) => left.version - right.version)
    .slice(-TEMPLATE_HISTORY_LIMIT);
  if (normalized.length || !fallbackSnapshot || Array.isArray(entries)) return normalized;
  return [capabilityTemplateHistoryRecord({ scopeType, scopeId, version: Math.max(1, Number(fallbackSnapshot.version) || 1), snapshot: fallbackSnapshot, reason: "initial" })];
};

const normalizeCapabilityTemplateState = (value, { customSlots = [], customSlotGroups = [] } = {}) => {
  if (!value?.current) return createInitialCapabilityTemplateState({ customSlots, customSlotGroups });
  // Normalize legacy state and discard durable empty placeholders. New slots
  // are held only in the client draft until a Skill is selected and saved.
  const current = applyCapabilityKernelMechanisms(pruneCapabilityTemplateEmptySlots(value.current));
  const history = {
    template: normalizedTemplateHistoryEntries(value.history?.template, { scopeType: "template", scopeId: current.template.id, fallbackSnapshot: current }),
    groups: {},
    modules: {},
  };
  for (const group of current.groups) history.groups[group.id] = normalizedTemplateHistoryEntries(value.history?.groups?.[group.id], { scopeType: "group", scopeId: group.id, fallbackSnapshot: group });
  for (const module of current.modules) history.modules[module.id] = normalizedTemplateHistoryEntries(value.history?.modules?.[module.id], { scopeType: "module", scopeId: module.id, fallbackSnapshot: module });
  for (const [id, entries] of Object.entries(value.history?.groups ?? {})) {
    if (!history.groups[id]) history.groups[id] = normalizedTemplateHistoryEntries(entries, { scopeType: "group", scopeId: id });
  }
  for (const [id, entries] of Object.entries(value.history?.modules ?? {})) {
    if (!history.modules[id]) history.modules[id] = normalizedTemplateHistoryEntries(entries, { scopeType: "module", scopeId: id });
  }
  return {
    schemaVersion: CAPABILITY_TEMPLATE_SCHEMA_VERSION,
    current,
    history,
    initializedAt: Number(value.initializedAt) || Date.now(),
    updatedAt: Number(value.updatedAt) || Date.now(),
  };
};

const publicTemplateHistoryRecord = ({ snapshot: _snapshot, routeSnapshot: _routeSnapshot, ...entry }) => entry;

const publicCapabilityTemplateState = (state = {}) => ({
  schemaVersion: CAPABILITY_TEMPLATE_SCHEMA_VERSION,
  current: state.current,
  history: {
    template: (state.history?.template ?? []).map(publicTemplateHistoryRecord).sort((left, right) => right.version - left.version),
    groups: Object.fromEntries(Object.entries(state.history?.groups ?? {}).map(([id, entries]) => [id, entries.map(publicTemplateHistoryRecord).sort((left, right) => right.version - left.version)])),
    modules: Object.fromEntries(Object.entries(state.history?.modules ?? {}).map(([id, entries]) => [id, entries.map(publicTemplateHistoryRecord).sort((left, right) => right.version - left.version)])),
  },
  initializedAt: state.initializedAt,
  updatedAt: state.updatedAt,
  topology: capabilityTemplateTopology(state.current),
});

const capabilityScopeType = (value = "") => value === "group" ? "group" : value === "template" ? "template" : "module";
const capabilityAssetTypeLabel = (value = "module") => value === "template" ? "面板" : value === "group" ? "模组" : "模块";
const capabilityAssetProductCopy = (value = "", assetType = "module") => assetType === "template"
  ? String(value).replaceAll("神思能力模板", "Skill 面板").replaceAll("当前模板", "当前面板").replaceAll("完整模板", "完整面板")
  : String(value);
const capabilityAssetMiniTemplate = ({ rootType, rootId, groups = [], modules = [] } = {}) => ({
  schemaVersion: CAPABILITY_TEMPLATE_SCHEMA_VERSION,
  template: {
    id: `template:asset:${hashText(`${rootType}:${rootId}`).slice(0, 16)}`,
    nodeType: "template",
    name: `${capabilityAssetTypeLabel(rootType)}资产包`,
    description: "用于完整保存模块或模组及其依赖，不直接作为运行面板。",
    triggerRules: "仅在安装或验证资产时读取。",
    relationType: "parallel",
    items: [{ id: `placement:asset:${hashText(`${rootType}:${rootId}`).slice(0, 16)}`, targetType: rootType, targetId: rootId, role: "peer" }],
    official: false,
    version: 1,
  },
  groups,
  modules,
});

const capabilityAssetPayloadFromBundle = (inputBundle, scopeType = "template", scopeId = "") => {
  const bundle = normalizeCapabilityTemplate(inputBundle);
  const type = capabilityScopeType(scopeType);
  if (type === "template") return { rootType: "template", rootId: bundle.template.id, bundle };
  const root = capabilityTemplateNode(bundle, type, scopeId);
  if (!root) throw new Error(`${capabilityAssetTypeLabel(type)}不存在`);
  if (type === "module") {
    return {
      rootType: type,
      rootId: root.id,
      bundle: capabilityAssetMiniTemplate({ rootType: type, rootId: root.id, modules: [structuredClone(root)] }),
    };
  }
  const groupMap = new Map(bundle.groups.map((group) => [group.id, group]));
  const moduleMap = new Map(bundle.modules.map((module) => [module.id, module]));
  const groupIds = new Set();
  const moduleIds = new Set();
  const queue = [root.id];
  while (queue.length) {
    const groupId = queue.shift();
    if (groupIds.has(groupId)) continue;
    const group = groupMap.get(groupId);
    if (!group) throw new Error(`模组依赖不存在：${groupId}`);
    groupIds.add(groupId);
    for (const item of group.items ?? []) {
      if (item.targetType === "group") queue.push(item.targetId);
      else moduleIds.add(item.targetId);
    }
  }
  const groups = [...groupIds].map((id) => structuredClone(groupMap.get(id)));
  const modules = [...moduleIds].map((id) => {
    const module = moduleMap.get(id);
    if (!module) throw new Error(`模块依赖不存在：${id}`);
    return structuredClone(module);
  });
  return {
    rootType: type,
    rootId: root.id,
    bundle: capabilityAssetMiniTemplate({ rootType: type, rootId: root.id, groups, modules }),
  };
};

const normalizeCapabilityAssetPayload = (value = {}, expectedType = "") => {
  const rootType = CAPABILITY_ASSET_TYPES.has(value?.rootType) ? value.rootType : expectedType;
  if (!CAPABILITY_ASSET_TYPES.has(rootType)) throw new Error("能力资产类型无效");
  const bundle = normalizeCapabilityTemplate(value?.bundle);
  const validation = validateCapabilityTemplate(bundle);
  if (!validation.valid) throw new Error(`能力资产结构无效：${validation.errors.join("；")}`);
  const rootId = rootType === "template" ? validation.bundle.template.id : String(value?.rootId || "");
  if (!capabilityTemplateNode(validation.bundle, rootType, rootId)) throw new Error(`能力资产缺少根${capabilityAssetTypeLabel(rootType)}`);
  const payload = { rootType, rootId, bundle: validation.bundle };
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_CAPABILITY_ASSET_BYTES) throw new Error("能力资产包不能超过 2 MB");
  return payload;
};

const capabilityAssetVersion = ({ version = 1, payload, includedSkills = [], source = "downloaded", trustLevel = "community", installedAt = Date.now(), marketplaceId = "" } = {}) => {
  const normalizedPayload = normalizeCapabilityAssetPayload(payload);
  return {
    version: Math.max(1, Number(version) || 1),
    hash: hashText(JSON.stringify(normalizedPayload)),
    installedAt,
    source,
    trustLevel,
    marketplaceId,
    payload: normalizedPayload,
    includedSkills: (Array.isArray(includedSkills) ? includedSkills : [])
      .map(normalizeCapabilityIncludedSkill)
      .filter(Boolean)
      .slice(0, 500),
  };
};

const normalizeStoredCapabilityAsset = (entry = {}) => {
  const assetType = CAPABILITY_ASSET_TYPES.has(entry.assetType) ? entry.assetType : "";
  if (!assetType) return null;
  const versions = (Array.isArray(entry.versions) ? entry.versions : []).flatMap((version) => {
    try {
      return [capabilityAssetVersion({ ...version, payload: normalizeCapabilityAssetPayload(version.payload, assetType) })];
    } catch {
      return [];
    }
  }).sort((left, right) => left.version - right.version).slice(-CAPABILITY_ASSET_HISTORY_LIMIT);
  if (!versions.length) return null;
  const activeVersion = versions.some((version) => version.version === Number(entry.activeVersion))
    ? Number(entry.activeVersion) : versions.at(-1).version;
  return {
    id: String(entry.id || `capability-asset:${assetType}:${randomUUID()}`).slice(0, 180),
    assetType,
    marketplaceId: String(entry.marketplaceId || "").slice(0, 180),
    sourceId: String(entry.sourceId || versions.at(-1).payload.rootId).slice(0, 180),
    localRootId: String(entry.localRootId || "").slice(0, 180),
    localNodeIds: unique(entry.localNodeIds).slice(0, 200),
    name: capabilityAssetProductCopy(entry.name || `未命名${capabilityAssetTypeLabel(assetType)}`, assetType).slice(0, 120),
    author: String(entry.author || "未声明").slice(0, 120),
    description: capabilityAssetProductCopy(entry.description || "", assetType).slice(0, 500),
    origin: entry.origin === "imported" ? "imported" : "downloaded",
    sourceType: SKILL_SOURCE_TYPES.some((item) => item.id === entry.sourceType) ? entry.sourceType : inferredSourceType(entry.sourceLabel, entry.origin),
    trustLevel: ["official", "verified", "community", "local"].includes(entry.trustLevel) ? entry.trustLevel : entry.origin === "imported" ? "local" : "community",
    sourceLabel: String(entry.sourceLabel || (entry.origin === "imported" ? "本地 Skill 包" : "Skill 广场")).slice(0, 160),
    integrationSkillId: String(entry.integrationSkillId || "").slice(0, 180),
    compositeRouting: entry.compositeRouting === true,
    processorSkillId: String(entry.processorSkillId || "").slice(0, 180),
    usageGuidance: String(entry.usageGuidance || "").slice(0, 1_200),
    modificationGuidance: String(entry.modificationGuidance || "").slice(0, 1_200),
    activeVersion,
    versions,
    testStatus: ["passed", "failed"].includes(entry.testStatus) ? entry.testStatus : "untested",
    testSummary: String(entry.testSummary || "尚未测试").slice(0, 500),
    lastTestedAt: Number(entry.lastTestedAt) || 0,
    installedAt: Number(entry.installedAt) || versions[0].installedAt,
    updatedAt: Number(entry.updatedAt) || versions.at(-1).installedAt,
  };
};

const publicCapabilityAssetVersion = ({ payload: _payload, includedSkills: _includedSkills, ...version }) => version;
const marketplacePublicReviews = (registry = {}, id = "") => unique(Array.isArray(id) ? id : [id])
  .flatMap((itemId) => registry.marketplaceReviews?.[String(itemId || "")] ?? [])
  .sort((left, right) => Number(right.updatedAt || right.createdAt) - Number(left.updatedAt || left.createdAt))
  .filter((review, index, reviews) => reviews.findIndex((candidate) => candidate.id === review.id) === index)
  .map((review) => ({
    id: review.id,
    authorName: review.authorName,
    avatarUrl: review.avatarUrl || "",
    rating: Number(review.rating) || 0,
    comment: review.comment,
    createdAt: Number(review.createdAt) || 0,
    updatedAt: Number(review.updatedAt) || Number(review.createdAt) || 0,
  }));
const marketplaceAggregateRating = (registry = {}, id = "") => {
  const reviews = marketplacePublicReviews(registry, id);
  if (!reviews.length) return { rating: 0, ratingCount: 0 };
  return {
    rating: Math.round((reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length) * 10) / 10,
    ratingCount: reviews.length,
  };
};
const capabilityAssetPublicPreview = (entry = {}) => {
  const record = (entry.versions ?? []).find((version) => version.version === entry.activeVersion) || entry.versions?.at(-1);
  const payload = record?.payload;
  const bundle = payload?.bundle;
  const root = bundle ? capabilityTemplateNode(bundle, entry.assetType, payload.rootId) : null;
  if (!root) return { previewItems: [], nodeCount: 0, slotCount: 0 };
  const previewItems = entry.assetType === "module"
    ? (root.slots ?? []).map((slot) => slot.name || slot.skillId || "空插槽")
    : (root.items ?? []).map((item) => capabilityTemplateNode(bundle, item.targetType, item.targetId)?.name || "节点不可用");
  return {
    previewItems: previewItems.slice(0, 9),
    nodeCount: (bundle.groups?.length ?? 0) + (bundle.modules?.length ?? 0),
    slotCount: (bundle.modules ?? []).reduce((total, module) => total + (module.slots?.length ?? 0), 0),
  };
};
const publicCapabilityAsset = (entry = {}, registry = {}) => ({
  id: entry.id,
  assetType: entry.assetType,
  marketplaceId: entry.marketplaceId,
  sourceId: entry.sourceId,
  localRootId: entry.localRootId,
  name: entry.name,
  author: entry.author,
  description: entry.description,
  origin: entry.origin,
  sourceType: entry.sourceType,
  trustLevel: entry.trustLevel,
  sourceLabel: entry.sourceLabel,
  integrationSkillId: entry.integrationSkillId,
  compositeRouting: entry.compositeRouting,
  processorSkillId: entry.processorSkillId,
  usageGuidance: entry.usageGuidance,
  modificationGuidance: entry.modificationGuidance,
  version: entry.activeVersion,
  versions: (entry.versions ?? []).map(publicCapabilityAssetVersion).sort((left, right) => right.version - left.version),
  testStatus: entry.testStatus,
  testSummary: entry.testSummary,
  lastTestedAt: entry.lastTestedAt,
  installedAt: entry.installedAt,
  active: entry.assetType === "template" && registry.activeCapabilityTemplateAssetId === entry.id,
  userRating: Number(registry.marketplaceRatings?.[entry.marketplaceId]) || 0,
  userReview: marketplacePublicReviews(registry, entry.marketplaceId)[0] || null,
  rating: marketplaceAggregateRating(registry, entry.marketplaceId).rating,
  ratingCount: marketplaceAggregateRating(registry, entry.marketplaceId).ratingCount,
  reviews: marketplacePublicReviews(registry, entry.marketplaceId),
  packageFormat: CAPABILITY_ASSET_PACKAGE_FORMAT,
  ...capabilityAssetPublicPreview(entry),
});

const normalizeCapabilityIncludedSkill = (value = {}) => {
  const skillId = String(value.skillId || value.id || "").trim().slice(0, 180);
  if (!skillId) return null;
  return {
    skillId,
    runtimeSkillId: String(value.runtimeSkillId || "").trim().slice(0, 180),
    name: String(value.name || skillId).trim().slice(0, 120),
    description: String(value.description || "").trim().slice(0, 500),
    capabilityBoundary: String(value.capabilityBoundary || value.description || "").trim().slice(0, 800),
    capabilities: unique(value.capabilities).filter((capability) => allowedSkillCapabilities("general").includes(capability)).slice(0, 32),
    workspaceModes: unique(value.workspaceModes).filter((mode) => ["project", "notebook", "general"].includes(mode)).slice(0, 3),
    inputRequirements: unique(value.inputRequirements).slice(0, 32),
    outputContract: String(value.outputContract || "").trim().slice(0, 800),
    triggerKeywords: unique(value.triggerKeywords).slice(0, 64),
    triggerConditions: unique(value.triggerConditions).slice(0, 64),
    sourceLabel: String(value.sourceLabel || "").trim().slice(0, 160),
    trustLevel: ["official", "verified", "community", "local"].includes(value.trustLevel) ? value.trustLevel : "local",
    detailAvailable: value.detailAvailable !== false,
  };
};

const normalizeCapabilityMarketplaceSubmission = (submission = {}) => {
  const assetType = CAPABILITY_ASSET_TYPES.has(submission.assetType) ? submission.assetType : "";
  if (!assetType) return null;
  try {
    const payload = normalizeCapabilityAssetPayload(submission.payload, assetType);
    const includedSkills = (Array.isArray(submission.includedSkills) ? submission.includedSkills : [])
      .map(normalizeCapabilityIncludedSkill)
      .filter(Boolean)
      .slice(0, 500);
    const publishedAt = Number(submission.publishedAt) || Date.now();
    return {
      id: String(submission.id || `capability-publication:${assetType}:${payload.rootId}@${submission.version || 1}`).slice(0, 220),
      assetType,
      sourceId: String(submission.sourceId || payload.rootId).slice(0, 180),
      name: capabilityAssetProductCopy(submission.name || `未命名${capabilityAssetTypeLabel(assetType)}`, assetType).slice(0, 120),
      author: String(submission.author || "未声明").slice(0, 120),
      version: Math.max(1, Number(submission.version) || 1),
      description: capabilityAssetProductCopy(submission.description || "", assetType).slice(0, 500),
      hash: hashText(JSON.stringify(payload)),
      semanticHash: String(submission.semanticHash || capabilityDerivativeFingerprint(payload)).slice(0, 128),
      payload,
      includedSkills,
      trustLevel: submission.trustLevel === "official" ? "official" : submission.trustLevel === "verified" ? "verified" : "community",
      sourceType: submission.sourceType === "official" ? "official" : SKILL_SOURCE_TYPES.some((item) => item.id === submission.sourceType) ? submission.sourceType : "local_folder",
      sourceLabel: String(submission.sourceLabel || "本地能力面板库").slice(0, 160),
      status: submission.status === "yanked" ? "yanked" : "published",
      publishedAt,
      yankedAt: Number(submission.yankedAt) || 0,
      popularity: Math.max(0, Number(submission.popularity) || 0),
      publisherAccountId: String(submission.publisherAccountId || "").trim().slice(0, 120),
      publisherRole: submission.publisherRole === "admin" ? "admin" : "user",
    };
  } catch {
    return null;
  }
};

const emptyRegistry = () => ({
  schemaVersion: REGISTRY_SCHEMA_VERSION,
  storageRevision: 0,
  skills: [],
  customSlots: defaultCustomSlots(),
  customSlotGroups: [],
  capabilityTemplate: createInitialCapabilityTemplateState({ customSlots: defaultCustomSlots(), customSlotGroups: [] }),
  marketplaceRatings: {},
  marketplaceReviews: {},
  marketplaceSubmissions: [],
  capabilityMarketplaceSubmissions: [],
  capabilityAssets: [],
  activeCapabilityTemplateAssetId: "",
  skillTrash: [],
  routeRevision: 0,
  routeDocument: normalizeRouteDocumentState(),
});

const normalizeStoredRegistry = (parsed = {}) => {
  const storedSchemaVersion = Math.max(0, Number(parsed.schemaVersion) || 0);
  const storedCapabilityTemplateVersion = Math.max(0, Number(parsed.capabilityTemplate?.current?.schemaVersion ?? parsed.capabilityTemplate?.schemaVersion) || 0);
  const capabilityTemplateMigrated = Boolean(parsed.capabilityTemplate?.current) && storedCapabilityTemplateVersion < CAPABILITY_TEMPLATE_SCHEMA_VERSION;
  const customSlotGroups = (Array.isArray(parsed.customSlotGroups) ? parsed.customSlotGroups : [])
    .filter((group) => group && /^[a-z0-9][a-z0-9._:-]{2,119}$/i.test(String(group.id ?? "")))
    .map((group) => ({
      id: String(group.id),
      name: String(group.name ?? "").trim().slice(0, 100),
      description: String(group.description ?? "").trim().slice(0, 300),
      parentGroupId: String(group.parentGroupId ?? "").trim(),
      groupType: SLOT_GROUP_TYPES.has(group.groupType) ? group.groupType : "parallel",
      leaderSlotId: String(group.leaderSlotId ?? "").trim(),
      createdAt: Number(group.createdAt) || 0,
      updatedAt: Number(group.updatedAt) || 0,
    }));
  const knownGroupIds = new Set([...FIXED_GROUP_IDS, ...customSlotGroups.map((group) => group.id)]);
  for (const group of customSlotGroups) {
    if (!knownGroupIds.has(group.parentGroupId) || group.parentGroupId === group.id) group.parentGroupId = "";
  }
  const storedCustomSlots = Array.isArray(parsed.customSlots) ? [...parsed.customSlots] : [];
  if (storedSchemaVersion < 4) {
    for (const seed of defaultCustomSlots()) {
      if (!storedCustomSlots.some((slot) => slot?.id === seed.id)) storedCustomSlots.push(seed);
    }
  }
  const validCapabilities = new Set(allowedSkillCapabilities("general"));
  let splitLegacySlot = false;
  const reservedSlotIds = new Set(storedCustomSlots.map((slot) => String(slot?.id ?? "")).filter(Boolean));
  const customSlots = storedCustomSlots.flatMap((slot) => {
    const requestedParent = String(slot?.parentGroupId ?? "").trim();
    const capabilities = [...new Set((Array.isArray(slot?.capabilities) ? slot.capabilities : [])
      .map((item) => String(item).trim()).filter((item) => validCapabilities.has(item)))];
    const base = {
      ...slot,
      capabilities: capabilities.slice(0, 1),
      slotType: slot?.slotType === "multi" && capabilities.length === 1 && PRIMARY_WRITER_SLOT_CAPABILITIES.has(capabilities[0]) ? "multi" : "single",
      secondarySkillIds: Array.from({ length: 3 }, (_, index) => String(slot?.secondarySkillIds?.[index] ?? "").replace(/^user:/, "").trim()),
      enabled: capabilities.length ? slot?.enabled === true : false,
      parentGroupId: knownGroupIds.has(requestedParent) ? requestedParent : inferredParentGroupId({ capabilities: capabilities.slice(0, 1) }),
    };
    if (capabilities.length <= 1) return [base];
    splitLegacySlot = true;
    return capabilities.map((capability, index) => {
      if (index === 0) return { ...base, capabilities: [capability] };
      const stem = String(slot?.id ?? `legacy.slot`).slice(0, 70);
      let suffix = index + 1;
      let id = `${stem}.c${suffix}`;
      while (reservedSlotIds.has(id)) id = `${stem}.c${++suffix}`;
      reservedSlotIds.add(id);
      return {
        ...base,
        id,
        name: `${String(slot?.name ?? "自定义插槽").trim()} · ${capability}`.slice(0, 100),
        capabilities: [capability],
        parentGroupId: knownGroupIds.has(requestedParent) ? requestedParent : inferredParentGroupId({ capabilities: [capability] }),
        createdAt: Number(slot?.createdAt) || 0,
        updatedAt: Date.now(),
      };
    });
  });
  const customSlotIds = new Set(customSlots.map((slot) => slot.id));
  for (const group of customSlotGroups) {
    if (!customSlotIds.has(group.leaderSlotId) || !customSlots.some((slot) => slot.id === group.leaderSlotId && slot.parentGroupId === group.id)) group.leaderSlotId = "";
  }
  const deprecatedSkillIds = new Set((Array.isArray(parsed.skills) ? parsed.skills : [])
    .filter(deprecatedPersonalSkillEntry)
    .map((entry) => String(entry?.id || "").trim())
    .filter(Boolean));
  const skills = (Array.isArray(parsed.skills) ? parsed.skills : []).filter((entry) => !deprecatedSkillIds.has(String(entry?.id || ""))).map((entry) => {
    const { enabled: _legacyEnabled, customSlotEnabled: _legacyCustomSlotEnabled, ...normalizedEntry } = entry ?? {};
    const officialMarketplaceItem = OFFICIAL_MARKETPLACE_SKILLS.find((item) => String(item.skillId ?? "").replace(/^user:/, "") === normalizedEntry.id && item.trustLevel === "official");
    if (!officialMarketplaceItem) return normalizedEntry;
    const recoverableSandboxFailure = normalizedEntry.testStatus === "failed" && /沙箱模型调用失败.*(?:API Key|模型|连接)/.test(String(normalizedEntry.testSummary ?? ""));
    return {
      ...normalizedEntry,
      origin: "downloaded",
      source: officialMarketplaceItem.sourceLabel,
      trustLevel: "official",
      sourceType: officialMarketplaceItem.sourceType,
      sourceLabel: officialMarketplaceItem.sourceLabel,
      ...(recoverableSandboxFailure ? {
        testStatus: "passed",
        testSummary: "官方 Skill 已通过内置静态合同与安全校验。",
      } : {}),
      versions: (normalizedEntry.versions ?? []).map((version) => version.version === normalizedEntry.activeVersion ? {
        ...version,
        source: "downloaded",
        trustLevel: "official",
        sourceType: officialMarketplaceItem.sourceType,
      } : version),
    };
  });
  for (const slot of customSlots) {
    if (deprecatedSkillIds.has(String(slot.skillId || "").replace(/^user:/, ""))) {
      slot.skillId = "";
      slot.enabled = Boolean(slot.developerSkillId);
    }
    slot.secondarySkillIds = (slot.secondarySkillIds ?? []).map((id) => (
      deprecatedSkillIds.has(String(id || "").replace(/^user:/, "")) ? "" : id
    ));
  }
  const marketplaceSubmissions = (Array.isArray(parsed.marketplaceSubmissions) ? parsed.marketplaceSubmissions : [])
    .filter((submission) => !deprecatedSkillIds.has(String(submission?.skillId || "").replace(/^user:/, "")))
    .filter((submission) => submission && /^[a-z0-9][a-z0-9._:-]{2,119}$/i.test(String(submission.skillId ?? "")))
    .map((submission) => {
      const entry = skills.find((skill) => skill.id === String(submission.skillId));
      const sandboxVerified = entry?.sandboxVerified === true && entry?.sandboxVerifiedVersion === String(submission.version ?? "");
      return {
        id: String(submission.id ?? `publication:${submission.skillId}@${submission.version || "unknown"}`).replace(/^submission:/, "publication:"),
        skillId: String(submission.skillId),
        name: String(submission.name ?? entry?.name ?? "").trim().slice(0, 120),
        author: String(submission.author ?? entry?.author ?? "").trim().slice(0, 120),
        version: String(submission.version ?? "").trim().slice(0, 40),
        description: String(submission.description ?? entry?.description ?? "").trim().slice(0, 500),
        hash: String(submission.hash ?? "").trim().slice(0, 128),
        semanticHash: String(submission.semanticHash ?? "").trim().slice(0, 128),
        content: String(submission.content ?? "").slice(0, MAX_SKILL_SOURCE_BYTES),
        trustLevel: submission.trustLevel === "verified" || sandboxVerified ? "verified" : "community",
        sourceType: submission.sourceType === "official" ? "official" : SKILL_SOURCE_TYPES.some((item) => item.id === submission.sourceType)
          ? submission.sourceType : entry?.sourceType || "local_folder",
        sourceLabel: String(submission.sourceLabel ?? entry?.sourceLabel ?? "本地 Skill 库").trim().slice(0, 160),
        capabilities: Array.isArray(submission.capabilities) ? submission.capabilities : entry?.capabilities ?? [],
        workspaceModes: Array.isArray(submission.workspaceModes) ? submission.workspaceModes : entry?.workspaceModes ?? [],
        status: submission.status === "yanked" ? "yanked" : "published",
        publishedAt: Number(submission.publishedAt ?? submission.submittedAt) || 0,
        yankedAt: Number(submission.yankedAt) || 0,
        assetType: "skill",
        publisherAccountId: String(submission.publisherAccountId || "").trim().slice(0, 120),
        publisherRole: submission.publisherRole === "admin" ? "admin" : "user",
      };
    });
  const capabilityMarketplaceSubmissions = (Array.isArray(parsed.capabilityMarketplaceSubmissions) ? parsed.capabilityMarketplaceSubmissions : [])
    .map(normalizeCapabilityMarketplaceSubmission)
    .filter(Boolean);
  const capabilityAssets = (Array.isArray(parsed.capabilityAssets) ? parsed.capabilityAssets : [])
    .map(normalizeStoredCapabilityAsset)
    .filter(Boolean);
  const marketplaceItemIds = new Set([
    ...OFFICIAL_MARKETPLACE_SKILLS.map((item) => item.id),
    ...officialCapabilityMarketplaceItems().map((item) => item.id),
    ...marketplaceSubmissions.map((submission) => submission.id),
    ...capabilityMarketplaceSubmissions.map((submission) => submission.id),
  ]);
  const skillTrash = (Array.isArray(parsed.skillTrash) ? parsed.skillTrash : [])
    .filter((item) => item && /^[a-z0-9][a-z0-9._:-]{2,119}$/i.test(String(item.skillId ?? item.entry?.id ?? "")))
    .map((item) => {
      const deletedAt = Number(item.deletedAt) || Date.parse(item.deletedAtIso || "") || Date.now();
      return {
        trashId: String(item.trashId || `skill-trash-${deletedAt}-${randomUUID()}`),
        skillId: String(item.skillId || item.entry?.id),
        title: String(item.title || item.entry?.name || item.skillId || "未命名 Skill").slice(0, 120),
        origin: normalizedOrigin(item.origin || item.entry?.origin),
        sourceLabel: String(item.sourceLabel || item.entry?.sourceLabel || "本地 Skill 库").slice(0, 160),
        archiveFolder: String(item.archiveFolder || item.trashId || ""),
        entry: item.entry && typeof item.entry === "object" ? item.entry : null,
        capabilityAsset: item.capabilityAsset ? normalizeStoredCapabilityAsset(item.capabilityAsset) : null,
        deletedAt,
        deletedAtIso: new Date(deletedAt).toISOString(),
        expiresAtIso: new Date(Number(item.expiresAt) || Date.parse(item.expiresAtIso || "") || deletedAt + SKILL_TRASH_RETENTION_MS).toISOString(),
      };
    })
    .filter((item) => item.entry && item.archiveFolder);
  const capabilityTemplate = normalizeCapabilityTemplateState(parsed.capabilityTemplate, { customSlots, customSlotGroups });
  if (deprecatedSkillIds.size) {
    const next = normalizeCapabilityTemplate(capabilityTemplate.current);
    for (const module of next.modules) {
      module.slots = module.slots.filter((slot) => !deprecatedSkillIds.has(String(slot.skillId || "").replace(/^user:/, "")));
    }
    capabilityTemplate.current = normalizeCapabilityTemplate(next);
  }
  const marketplaceReviews = Object.fromEntries(Object.entries(parsed.marketplaceReviews ?? {}).flatMap(([id, reviews]) => {
    if (!marketplaceItemIds.has(id) || !Array.isArray(reviews)) return [];
    const normalized = reviews.map((review, index) => ({
      id: String(review?.id || `review:${id}:${index + 1}`).slice(0, 220),
      authorId: String(review?.authorId || "local-user").slice(0, 120),
      authorName: String(review?.authorName || "神思用户").trim().slice(0, 80) || "神思用户",
      avatarUrl: String(review?.avatarUrl || "").trim().slice(0, 500),
      rating: Number(review?.rating) || 0,
      comment: String(review?.comment || "").trim().slice(0, 1_000),
      createdAt: Number(review?.createdAt) || Date.now(),
      updatedAt: Number(review?.updatedAt) || Number(review?.createdAt) || Date.now(),
    })).filter((review) => review.rating >= 1 && review.rating <= 5 && review.comment.length >= 2).slice(-200);
    return normalized.length ? [[id, normalized]] : [];
  }));
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    storageRevision: Math.max(0, Number(parsed.storageRevision) || 0),
    skills,
    customSlots,
    customSlotGroups,
    capabilityTemplate,
    marketplaceRatings: Object.fromEntries(Object.entries(parsed.marketplaceRatings ?? {})
      .filter(([id, rating]) => marketplaceItemIds.has(id)
        && Number.isInteger(Number(rating)) && Number(rating) >= 1 && Number(rating) <= 5)
      .map(([id, rating]) => [id, Number(rating)])),
    marketplaceReviews,
    marketplaceSubmissions,
    capabilityMarketplaceSubmissions,
    capabilityAssets,
    activeCapabilityTemplateAssetId: capabilityAssets.some((asset) => asset.assetType === "template" && asset.id === parsed.activeCapabilityTemplateAssetId)
      ? String(parsed.activeCapabilityTemplateAssetId) : "",
    skillTrash,
    routeRevision: Math.max(0, Number(parsed.routeRevision) || 0) + (splitLegacySlot ? 1 : 0) + (capabilityTemplateMigrated ? 1 : 0) + (deprecatedSkillIds.size ? 1 : 0),
    routeDocument: normalizeRouteDocumentState(parsed.routeDocument),
  };
};

const parseStoredRegistry = (content, sourcePath) => {
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.skills)) {
    const invalid = new Error(`Skill 注册表结构损坏：${sourcePath}`);
    invalid.code = "SKILL_REGISTRY_INVALID";
    throw invalid;
  }
  return parsed;
};

const readRegistry = async (root) => {
  const withPublisherAuthority = async (registry) => applyLocalPublisherAuthority(registry, await readLocalPublisherAuthority(root));
  const path = registryFile(root);
  try {
    const metadata = await stat(path);
    const cached = registryReadCache.get(path);
    if (cached && cached.mtimeMs === metadata.mtimeMs && cached.size === metadata.size) {
      skillStoreCacheMetrics.registryHits += 1;
      return withPublisherAuthority(cached.registry);
    }
    skillStoreCacheMetrics.registryMisses += 1;
    const parsed = parseStoredRegistry(await readFile(path, "utf8"), path);
    const deprecatedSkillIds = (Array.isArray(parsed.skills) ? parsed.skills : [])
      .filter(deprecatedPersonalSkillEntry)
      .map((entry) => String(entry?.id || "").trim())
      .filter((id) => /^[a-z0-9][a-z0-9._:-]{2,119}$/i.test(id));
    const registry = normalizeStoredRegistry(parsed);
    const storedCapabilityTemplateVersion = Math.max(
      0,
      Number(parsed.capabilityTemplate?.current?.schemaVersion ?? parsed.capabilityTemplate?.schemaVersion) || 0,
    );
    if (
      Number(parsed.schemaVersion) !== REGISTRY_SCHEMA_VERSION
      || (parsed.capabilityTemplate?.current && storedCapabilityTemplateVersion < CAPABILITY_TEMPLATE_SCHEMA_VERSION)
    ) {
      await writeRegistry(root, registry);
      const userRoot = resolve(root, USER_DIRECTORY);
      for (const id of deprecatedSkillIds) {
        const target = resolve(userRoot, id);
        if (target !== userRoot && isInside(target, userRoot)) await rm(target, { recursive: true, force: true }).catch(() => {});
      }
      return withPublisherAuthority(registry);
    }
    registryReadCache.set(path, { mtimeMs: metadata.mtimeMs, size: metadata.size, registry });
    return withPublisherAuthority(registry);
  } catch (error) {
    if (error?.code === "ENOENT") return withPublisherAuthority(emptyRegistry());
    if (["SKILL_REGISTRY_CONFLICT", "SKILL_REGISTRY_LOCK_TIMEOUT"].includes(error?.code)) throw error;
    const previousPath = registryPreviousFile(root);
    try {
      const recovered = normalizeStoredRegistry(parseStoredRegistry(await readFile(previousPath, "utf8"), previousPath));
      await writeRegistry(root, recovered, { allowCorruptCurrent: true, preservePrevious: false });
      return withPublisherAuthority(recovered);
    } catch (recoveryError) {
      const unrecoverable = new Error("Skill 注册表损坏且没有可恢复的上一版本，已停止写入以避免覆盖原数据");
      unrecoverable.code = "SKILL_REGISTRY_UNRECOVERABLE";
      unrecoverable.statusCode = 500;
      unrecoverable.cause = recoveryError;
      throw unrecoverable;
    }
  }
};

const registryPayload = (registry, storageRevision) => ({
  schemaVersion: REGISTRY_SCHEMA_VERSION,
  storageRevision,
  skills: registry.skills,
  customSlots: registry.customSlots ?? [],
  customSlotGroups: registry.customSlotGroups ?? [],
  capabilityTemplate: registry.capabilityTemplate ?? createInitialCapabilityTemplateState({ customSlots: registry.customSlots ?? [], customSlotGroups: registry.customSlotGroups ?? [] }),
  marketplaceRatings: registry.marketplaceRatings ?? {},
  marketplaceReviews: registry.marketplaceReviews ?? {},
  marketplaceSubmissions: registry.marketplaceSubmissions ?? [],
  capabilityMarketplaceSubmissions: registry.capabilityMarketplaceSubmissions ?? [],
  capabilityAssets: registry.capabilityAssets ?? [],
  activeCapabilityTemplateAssetId: registry.activeCapabilityTemplateAssetId ?? "",
  skillTrash: registry.skillTrash ?? [],
  routeRevision: Math.max(0, Number(registry.routeRevision) || 0),
  routeDocument: normalizeRouteDocumentState(registry.routeDocument),
});

const writeRegistry = async (root, registry, { allowCorruptCurrent = false, preservePrevious = true } = {}) => {
  const path = registryFile(root);
  const expectedRevision = Math.max(0, Number(registry.storageRevision) || 0);
  await withRegistryLock(root, async () => {
    let currentContent = "";
    let currentRevision = 0;
    try {
      currentContent = await readFile(path, "utf8");
      const current = parseStoredRegistry(currentContent, path);
      currentRevision = Math.max(0, Number(current.storageRevision) || 0);
    } catch (error) {
      if (error?.code !== "ENOENT" && !allowCorruptCurrent) {
        const corrupt = new Error("Skill 注册表当前版本无法解析，已停止写入并保留原文件");
        corrupt.code = "SKILL_REGISTRY_CORRUPT";
        corrupt.statusCode = 409;
        corrupt.cause = error;
        throw corrupt;
      }
      currentContent = "";
      currentRevision = expectedRevision;
    }
    if (!allowCorruptCurrent && currentRevision !== expectedRevision) {
      const conflict = new Error("Skill 注册表已在另一个窗口中更新，请重新加载后再保存");
      conflict.code = "SKILL_REGISTRY_CONFLICT";
      conflict.statusCode = 409;
      throw conflict;
    }
    if (preservePrevious && currentContent) {
      parseStoredRegistry(currentContent, path);
      await atomicWrite(registryPreviousFile(root), currentContent);
    }
    const nextRevision = Math.max(currentRevision, expectedRevision) + 1;
    await atomicWrite(path, JSON.stringify(registryPayload(registry, nextRevision), null, 2));
    registry.storageRevision = nextRevision;
    registryReadCache.delete(path);
  });
};

const readSkillVersionSource = async (path) => {
  const metadata = await stat(path);
  const cached = skillVersionReadCache.get(path);
  if (cached && cached.mtimeMs === metadata.mtimeMs && cached.size === metadata.size) {
    skillStoreCacheMetrics.versionHits += 1;
    return cached.content;
  }
  skillStoreCacheMetrics.versionMisses += 1;
  const content = await readFile(path, "utf8");
  skillVersionReadCache.set(path, { mtimeMs: metadata.mtimeMs, size: metadata.size, content });
  return content;
};

export const managedSkillStoreCacheStats = () => ({ ...skillStoreCacheMetrics });

const publicVersion = (version = {}) => ({
  version: version.version,
  upstreamVersion: version.upstreamVersion || "",
  upstreamId: version.upstreamId || "",
  hash: version.hash,
  installedAt: version.installedAt,
  source: version.source,
  trustLevel: version.trustLevel ?? "local",
  sourceType: version.sourceType ?? "local_folder",
  testStatus: version.testStatus ?? "untested",
  testSummary: version.testSummary ?? "尚未测试",
  lastTestedAt: version.lastTestedAt ?? 0,
  compositeChildCount: version.compositeDefinition?.children?.length ?? 0,
});

const publicSkill = (entry = {}) => {
  const origin = normalizedOrigin(entry.origin);
  const trustLevel = normalizedTrustLevel(entry.trustLevel, entry.origin);
  const compositeCapabilities = unique(entry.compositeDefinition?.capabilities);
  const compositeWorkspaceModes = unique(entry.compositeDefinition?.workspaceModes);
  return {
    id: `user:${entry.id}`,
    skillId: entry.id,
    name: entry.name,
    version: entry.activeVersion,
    author: entry.author,
    description: entry.description,
    prototypeId: entry.prototypeId || "",
    prototypeName: entry.prototypeName || "",
    prototypeFingerprint: entry.prototypeFingerprint || "",
    derivativeCopy: entry.derivativeCopy === true,
    upstreamId: entry.upstreamId || "",
    upstreamVersion: entry.upstreamVersion || "",
    changeSummary: entry.changeSummary || "",
    capabilityBoundary: entry.capabilityBoundary || entry.description,
    origin,
    source: entry.source,
    trustLevel,
    sourceType: entry.sourceType || inferredSourceType(entry.source, entry.origin),
    sourceLabel: entry.sourceLabel || entry.source || "本地 Skill 库",
    packageFormat: "shensi-skill-package-v1",
    capabilities: unique([...(entry.capabilities ?? []), ...compositeCapabilities]).filter((capability) => allowedSkillCapabilities("general").includes(capability)),
    role: entry.role,
    workspaceModes: unique([...(entry.workspaceModes ?? []), ...compositeWorkspaceModes]),
    artifactTypes: entry.artifactTypes ?? [],
    inputRequirements: entry.inputRequirements ?? [],
    outputContract: entry.outputContract,
    stages: entry.stages ?? [],
    slots: entry.slots ?? [],
    conflictPolicy: entry.conflictPolicy ?? "replace",
    fallback: entry.fallback ?? "builtin",
    disabled: entry.disabled === true,
    triggerKeywords: entry.triggerKeywords ?? [],
    triggerConditions: entry.triggerConditions ?? [],
    hash: entry.hash,
    installedAt: entry.installedAt,
    lastTestedAt: entry.lastTestedAt ?? 0,
    testStatus: entry.testStatus ?? "untested",
    testSummary: entry.testSummary ?? "尚未测试",
    sandboxVerified: entry.sandboxVerified === true && entry.sandboxVerifiedVersion === entry.activeVersion,
    localRating: Number(entry.localRating) || 0,
    primaryCapable: skillHasPrimaryCapability(entry, "project") || skillHasPrimaryCapability(entry, "notebook"),
    libraryVisibility: entry.compositeDefinition ? "composite-root" : "normal",
    compositeAssetId: entry.compositeDefinition?.assetId || "",
    compositeRouting: entry.compositeDefinition?.hasInternalRouting === true,
    compositeChildCount: entry.compositeDefinition?.children?.length ?? 0,
    importProcessorId: entry.compositeDefinition ? COMPOSITE_SKILL_PROCESSOR.id : "",
    versions: (entry.versions ?? []).map(publicVersion),
  };
};

const liveCapabilityIncludedSkill = (skillId = "", registry = {}) => {
  const requested = canonicalBuiltinSkillId(skillId);
  if (!requested) return null;
  const fixed = [...FIXED_SKILL_SLOT_CATALOG, ...BUILTIN_SKILLS].find((skill) => skill.id === requested);
  if (fixed) return normalizeCapabilityIncludedSkill({
    ...fixed,
    skillId: requested,
    capabilities: fixed.capabilities ?? fixed.replacementCapabilities ?? [],
    capabilityBoundary: fixed.capabilityBoundary || `只在“${fixed.name}”对应插槽授权范围内生效。`,
    sourceLabel: "神思官方内嵌固定插槽",
    trustLevel: "official",
  });
  const managedId = requested.replace(/^user:/, "");
  const managed = (registry.skills ?? []).find((entry) => entry.id === managedId);
  if (managed) return normalizeCapabilityIncludedSkill({ ...publicSkill(managed), skillId: requested });
  const official = OFFICIAL_MARKETPLACE_SKILLS.find((item) => [
    item.id,
    item.skillId,
    item.managedSkillId,
    item.skillId ? `user:${String(item.skillId).replace(/^user:/, "")}` : "",
    item.managedSkillId ? `user:${String(item.managedSkillId).replace(/^user:/, "")}` : "",
  ].includes(requested));
  if (official) return normalizeCapabilityIncludedSkill({
    ...official,
    skillId: requested,
    capabilityBoundary: official.capabilityBoundary || `只在“${official.name}”对应插槽授权范围内生效。`,
    detailAvailable: true,
  });
  return null;
};

const capabilityIncludedSkills = (payload = {}, registry = {}, storedSkills = []) => {
  const storedById = new Map((Array.isArray(storedSkills) ? storedSkills : [])
    .map(normalizeCapabilityIncludedSkill)
    .filter(Boolean)
    .map((skill) => [skill.skillId, skill]));
  const result = [];
  const seen = new Set();
  for (const module of payload.bundle?.modules ?? []) {
    for (const slot of module.slots ?? []) {
      const skillId = String(slot.skillId || "").trim();
      const descriptorId = String(slot.compositeChildId || skillId).trim();
      if (!skillId || !descriptorId || seen.has(descriptorId)) continue;
      seen.add(descriptorId);
      const live = liveCapabilityIncludedSkill(skillId, registry);
      const stored = storedById.get(descriptorId);
      const descriptor = normalizeCapabilityIncludedSkill({
        skillId: descriptorId,
        runtimeSkillId: slot.compositeChildId ? skillId : "",
        name: slot.name || skillId,
        description: "发布快照未附带此 Skill 的能力说明。",
        capabilityBoundary: "需要安装对应 Skill 后才能确认完整能力边界。",
        capabilities: slot.capabilities ?? [],
        detailAvailable: false,
        ...(live ?? {}),
        ...(stored ?? {}),
        skillId: descriptorId,
        runtimeSkillId: slot.compositeChildId ? skillId : stored?.runtimeSkillId || "",
      });
      if (descriptor) result.push(descriptor);
    }
  }
  return result;
};

export const listBuiltinSkills = () => BUILTIN_SKILLS.map((skill) => ({
  ...skill,
  origin: "developer",
  capabilityBoundary: `只在“${skill.name}”开发者插槽声明的替换能力内生效；可信内核能力不可替换。`,
}));

export const listFixedSkillSlots = () => FIXED_SKILL_SLOT_CATALOG.map((skill) => ({
  ...skill,
  origin: "developer",
  developerDefault: skill.developerDefault !== false,
  capabilityBoundary: `只在“${skill.name}”固定插槽声明的替换能力内生效；实时路由拓扑与可信内核能力不可替换。`,
}));

const allSlotGroups = (registry = {}) => [
  ...FIXED_SKILL_SLOT_GROUPS.map((group) => ({ ...group, groupType: group.groupType ?? "parallel", leaderSlotId: group.leaderSlotId ?? "" })),
  ...(registry.customSlotGroups ?? []).map((group) => ({ ...group, fixed: false, allowedCapabilities: [], writerSubstitutionCapabilities: [], priorityWeight: 0, groupType: group.groupType ?? "parallel", leaderSlotId: group.leaderSlotId ?? "" })),
];

const groupLineage = (groupId = "", registry = {}) => {
  const groups = new Map(allSlotGroups(registry).map((group) => [group.id, group]));
  const lineage = [];
  const visited = new Set();
  let current = groups.get(groupId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    lineage.unshift(current);
    current = groups.get(current.parentGroupId);
  }
  return lineage;
};

const groupPriority = (groupId = "", registry = {}) => groupLineage(groupId, registry)
  .reduce((total, group) => total + (Number(group.priorityWeight) || 0), 0);

const publicCustomGroup = (group = {}, registry = {}) => ({
  id: group.id,
  name: group.name,
  description: group.description,
  parentGroupId: group.parentGroupId ?? "",
  groupType: group.groupType ?? "parallel",
  leaderSlotId: group.leaderSlotId ?? "",
  fixed: false,
  routePriority: groupPriority(group.id, registry),
  createdAt: group.createdAt ?? 0,
  updatedAt: group.updatedAt ?? 0,
});

const publicCustomSlot = (slot = {}, registry = null) => {
  const entry = registry?.skills?.find((item) => item.id === slot.skillId);
  const secondaryEntries = Array.from({ length: 3 }, (_, index) => {
    const id = slot.secondarySkillIds?.[index] ?? "";
    return id ? registry?.skills?.find((item) => item.id === id) : null;
  });
  const hasDeveloperDefault = Boolean(slot.developerSkillId);
  const replacementReady = Boolean(entry?.testStatus === "passed");
  return {
    id: slot.id,
    name: slot.name,
    description: slot.description,
    parentGroupId: slot.parentGroupId ?? "",
    groupPath: groupLineage(slot.parentGroupId, registry).map((group) => ({ id: group.id, name: group.name })),
    routePriority: groupPriority(slot.parentGroupId, registry),
    order: Number(slot.order) || 0,
    capabilityBoundary: slot.capabilityBoundary,
    workspaceModes: slot.workspaceModes ?? [],
    capabilities: slot.capabilities ?? [],
    slotType: slot.slotType === "multi" ? "multi" : "single",
    triggerKeywords: slot.triggerKeywords ?? [],
    triggerConditions: slot.triggerConditions ?? [],
    skillId: slot.skillId ? `user:${slot.skillId}` : "",
    secondarySkillIds: Array.from({ length: 3 }, (_, index) => slot.secondarySkillIds?.[index] ? `user:${slot.secondarySkillIds[index]}` : ""),
    secondarySkillNames: secondaryEntries.map((secondary) => secondary?.name ?? ""),
    skillName: replacementReady ? entry.name : slot.developerSkillName ?? entry?.name ?? "",
    replacementSkillName: entry?.name ?? "",
    developerSkillId: slot.developerSkillId ?? "",
    developerSkillName: slot.developerSkillName ?? "",
    developerDefault: hasDeveloperDefault,
    usingDeveloperDefault: hasDeveloperDefault && !replacementReady,
    enabled: slot.enabled === true,
    ready: hasDeveloperDefault || replacementReady,
    createdAt: slot.createdAt ?? 0,
    updatedAt: slot.updatedAt ?? 0,
  };
};

export const ensureSkillStore = async () => {
  const root = resolve(persistentSkillsRoot());
  await mkdir(join(root, USER_DIRECTORY), { recursive: true });
  await mkdir(join(root, SKILL_TRASH_DIRECTORY), { recursive: true });
  const path = registryFile(root);
  if (!(await stat(path).catch(() => null))) await writeRegistry(root, emptyRegistry());
  return root;
};

const skillTrashRoot = (root) => resolve(root, SKILL_TRASH_DIRECTORY);
const skillTrashPath = (root, archiveFolder) => {
  const target = resolve(skillTrashRoot(root), String(archiveFolder || ""));
  if (!isInside(target, skillTrashRoot(root)) || target === skillTrashRoot(root)) throw new Error("Skill 回收路径越界");
  return target;
};

const publicSkillTrashEntry = (item = {}) => ({
  trashId: item.trashId,
  id: `user:${item.skillId}`,
  skillId: item.skillId,
  kind: "skill",
  title: item.title,
  origin: normalizedOrigin(item.origin),
  sourceLabel: item.sourceLabel || "本地 Skill 库",
  versionCount: item.entry?.versions?.length ?? 0,
  activeVersion: item.entry?.activeVersion || "",
  composite: Boolean(item.capabilityAsset || item.entry?.compositeDefinition),
  deletedAtIso: item.deletedAtIso,
  expiresAtIso: item.expiresAtIso,
  recoveryHint: normalizedOrigin(item.origin) === "downloaded"
    ? "永久清理后可从 Skill 广场重新下载"
    : "永久清理后只能重新导入原 Skill 包",
});

const pruneExpiredSkillTrash = async (root, registry, now = Date.now()) => {
  const expired = (registry.skillTrash ?? []).filter((item) => Date.parse(item.expiresAtIso) <= now);
  if (!expired.length) return [];
  for (const item of expired) await rm(skillTrashPath(root, item.archiveFolder), { recursive: true, force: true });
  const expiredIds = new Set(expired.map((item) => item.trashId));
  registry.skillTrash = (registry.skillTrash ?? []).filter((item) => !expiredIds.has(item.trashId));
  await writeRegistry(root, registry);
  return expired.map(publicSkillTrashEntry);
};

export const listManagedSkillTrash = async () => {
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  await pruneExpiredSkillTrash(root, registry);
  return (registry.skillTrash ?? [])
    .map(publicSkillTrashEntry)
    .sort((left, right) => Date.parse(right.deletedAtIso) - Date.parse(left.deletedAtIso));
};

const marketplaceManagedSkillId = (item = {}) => String(item.managedSkillId || item.skillId || "").replace(/^user:/, "");
const marketplaceAssetType = (item = {}) => MARKETPLACE_ASSET_TYPES.has(item.assetType) ? item.assetType : "skill";
const marketplaceArtifactKey = (item = {}) => marketplaceAssetType(item) === "skill"
  ? `skill:${marketplaceManagedSkillId(item) || item.id || "unknown"}`
  : `${marketplaceAssetType(item)}:${item.sourceId || item.payload?.rootId || item.id || "unknown"}`;

let officialCapabilityMarketplaceCache = null;
const officialCapabilityMarketplaceItems = () => {
  if (officialCapabilityMarketplaceCache) return officialCapabilityMarketplaceCache;
  const bundle = createInitialCapabilityTemplate();
  const definitions = [
    {
      id: "official:capability:module:auxiliary",
      assetType: "module",
      sourceId: "module:auxiliary-skills",
      name: "官方辅助能力模块",
      description: "可直接放在面板根层的辅助能力模块，包含爆款拆书、文风蒸馏与小说封面设计插槽。",
      popularity: 720,
      publishedAt: Date.UTC(2026, 6, 20),
    },
    {
      id: "official:capability:group:prompt-engineering",
      assetType: "group",
      sourceId: "group:prompt-engineering",
      name: "官方提示词工程模组",
      description: "提示词创作引导、通用提示词主笔与 AI 视频导演（二）模块组成的能力模组。",
      popularity: 680,
      publishedAt: Date.UTC(2026, 6, 20),
    },
    {
      id: "official:capability:group:novel",
      assetType: "group",
      sourceId: "group:novel",
      name: "长篇小说模组",
      description: "长篇小说的引导、规划、主笔、自检、理论与内置记忆工程能力版图。",
      popularity: 860,
      publishedAt: Date.UTC(2026, 6, 20),
      legacyPublicationIds: ["capability-publication:group:group:novel@1"],
    },
    {
      id: "official:capability:template:starter",
      assetType: "template",
      sourceId: bundle.template.id,
      name: "Skill 面板",
      description: "官方初始能力版图；可下载、检查、修改，并作为整套运行面板切换启用。",
      popularity: 900,
      publishedAt: Date.UTC(2026, 6, 20),
      legacyPublicationIds: ["capability-publication:template:template:shensi@1"],
    },
  ];
  officialCapabilityMarketplaceCache = definitions.map((definition) => ({
    ...definition,
    author: "神思团队",
    version: 1,
    trustLevel: "official",
    sourceType: "official",
    sourceLabel: "神思官方目录",
    workspaceModes: ["general"],
    capabilities: [],
    payload: capabilityAssetPayloadFromBundle(bundle, definition.assetType, definition.sourceId),
  }));
  return officialCapabilityMarketplaceCache;
};

const visibleCapabilityMarketplaceSubmissions = (registry = {}) => (registry.capabilityMarketplaceSubmissions ?? [])
  .filter((publication) => publication.status === "published");

const userSkillMarketplaceItems = (registry = {}) => (registry.marketplaceSubmissions ?? [])
  .filter((publication) => publication.status === "published"
    && publication.trustLevel !== "official"
    && publication.sourceType !== "official")
  .map(marketplacePublicationItem);

const marketplaceAllItems = (registry = {}) => [
  ...OFFICIAL_MARKETPLACE_SKILLS.map((item) => ({ ...item, assetType: "skill" })),
  ...officialCapabilityMarketplaceItems(),
  ...(registry.marketplaceSubmissions ?? [])
    .filter((publication) => publication.status === "published")
    .map(marketplacePublicationItem),
  ...visibleCapabilityMarketplaceSubmissions(registry),
];

// The public square is a user-sharing surface. Official Skills and official
// capability structures ship with the application and are displayed through
// the official panel hierarchy instead of masquerading as downloadable items.
const marketplaceUserItems = (registry = {}) => userSkillMarketplaceItems(registry);

const marketplaceSubmissionItems = (registry = {}) => [
  ...(registry.marketplaceSubmissions ?? []).map(marketplacePublicationItem),
  ...(registry.capabilityMarketplaceSubmissions ?? []),
];

const marketplaceVersionItems = (item = {}, registry = {}, { includeYanked = false } = {}) => {
  const artifactKey = marketplaceArtifactKey(item);
  const candidates = includeYanked
    ? [...OFFICIAL_MARKETPLACE_SKILLS.map((entry) => ({ ...entry, assetType: "skill" })), ...officialCapabilityMarketplaceItems(), ...marketplaceSubmissionItems(registry)]
    : marketplaceAllItems(registry);
  return candidates
    .filter((candidate) => marketplaceArtifactKey(candidate) === artifactKey)
    .sort((left, right) => {
      const publishedDelta = (Number(right.publishedAt) || 0) - (Number(left.publishedAt) || 0);
      if (publishedDelta) return publishedDelta;
      return String(right.version ?? "").localeCompare(String(left.version ?? ""), undefined, { numeric: true });
    });
};

const publicMarketplaceSkill = (item = {}, registry = {}, { includeYanked = false } = {}) => {
  const assetType = marketplaceAssetType(item);
  const marketplaceIds = unique([item.id, ...(item.legacyPublicationIds ?? [])]);
  const aggregate = marketplaceAggregateRating(registry, marketplaceIds);
  const reviews = marketplacePublicReviews(registry, marketplaceIds);
  const installedEntry = assetType === "skill"
    ? (registry.skills ?? []).find((entry) => entry.id === marketplaceManagedSkillId(item))
    : (registry.capabilityAssets ?? []).find((entry) => entry.marketplaceId === item.id || (item.sourceId && entry.sourceId === item.sourceId));
  const updateAvailable = Boolean(installedEntry) && (assetType === "skill"
    ? !(installedEntry.versions ?? []).some((version) => String(version.version) === String(item.version)
      || version.upstreamId === item.id && String(version.upstreamVersion) === String(item.version))
    : !(installedEntry.versions ?? []).some((version) => version.marketplaceId === item.id || (item.hash && version.hash === item.hash)));
  const { installContent, payload: _payload, includedSkills: _includedSkills, legacyPublicationIds: _legacyPublicationIds, ...publicItem } = item;
  return {
    ...publicItem,
    assetType,
    includedSkillCount: assetType === "skill" ? 0 : capabilityIncludedSkills(item.payload, registry, item.includedSkills).length,
    installed: Boolean(installedEntry),
    updateAvailable,
    installedSkillId: assetType === "skill" && installedEntry ? `user:${installedEntry.id}` : "",
    installedAssetId: assetType !== "skill" && installedEntry ? installedEntry.id : "",
    active: assetType === "template" && installedEntry?.id === registry.activeCapabilityTemplateAssetId,
    userRating: marketplaceIds.map((id) => Number(registry.marketplaceRatings?.[id]) || 0).find(Boolean) || 0,
    userReview: reviews[0] || null,
    rating: aggregate.rating || Number(item.rating) || 0,
    ratingCount: aggregate.ratingCount || Number(item.ratingCount) || 0,
    reviews,
    publicationStatus: item.status === "yanked" ? "yanked" : "published",
    versions: marketplaceVersionItems(item, registry, { includeYanked }).map((version) => ({
      id: version.id,
      assetType: marketplaceAssetType(version),
      version: version.version,
      name: version.name,
      author: version.author,
      description: version.description,
      trustLevel: version.trustLevel,
      sourceLabel: version.sourceLabel,
      publishedAt: Number(version.publishedAt) || 0,
      status: version.status === "yanked" ? "yanked" : "published",
      yankedAt: Number(version.yankedAt) || 0,
      hash: version.hash || "",
    })),
  };
};

const managedPersonalSkillCatalog = (registry = {}) => {
  const managed = (registry.skills ?? []).map(publicSkill);
  return managed.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
};

const publicMarketplaceSubmission = (submission = {}) => ({
  id: submission.id,
  assetType: marketplaceAssetType(submission),
  skillId: submission.skillId,
  sourceId: submission.sourceId,
  name: submission.name,
  author: submission.author,
  version: submission.version,
  trustLevel: submission.trustLevel,
  publisherRole: submission.publisherRole === "admin" ? "admin" : "user",
  status: submission.status,
  publishedAt: submission.publishedAt,
  yankedAt: Number(submission.yankedAt) || 0,
});

const marketplacePublicationItem = (publication = {}) => ({
  id: publication.id,
  assetType: "skill",
  skillId: publication.skillId,
  name: publication.name,
  author: publication.author,
  version: publication.version,
  description: publication.description,
  hash: publication.hash,
  semanticHash: publication.semanticHash,
  trustLevel: publication.trustLevel,
  publisherRole: publication.publisherRole === "admin" ? "admin" : "user",
  sourceType: publication.sourceType,
  sourceLabel: publication.sourceLabel,
  capabilities: publication.capabilities ?? [],
  workspaceModes: publication.workspaceModes ?? [],
  publishedAt: publication.publishedAt,
  yankedAt: Number(publication.yankedAt) || 0,
  status: publication.status === "yanked" ? "yanked" : "published",
  popularity: Number(publication.popularity) || 0,
  installContent: String(publication.content || ""),
  localPreview: !publication.content,
});

const marketplaceCatalogItems = (registry = {}) => {
  const seen = new Set();
  return marketplaceUserItems(registry)
    .sort((left, right) => {
      const publishedDelta = (Number(right.publishedAt) || 0) - (Number(left.publishedAt) || 0);
      if (publishedDelta) return publishedDelta;
      return String(right.version ?? "").localeCompare(String(left.version ?? ""), undefined, { numeric: true });
    })
    .filter((item) => {
      const artifactKey = marketplaceArtifactKey(item);
      if (seen.has(artifactKey)) return false;
      seen.add(artifactKey);
      return true;
    });
};

const marketplaceOwnedCatalogItems = (registry = {}) => {
  const seen = new Set();
  return (registry.marketplaceSubmissions ?? [])
    .filter((item) => item.trustLevel !== "official" && item.sourceType !== "official")
    .map(marketplacePublicationItem)
    .sort((left, right) => {
      const publishedDelta = (Number(right.publishedAt) || 0) - (Number(left.publishedAt) || 0);
      if (publishedDelta) return publishedDelta;
      return String(right.version ?? "").localeCompare(String(left.version ?? ""), undefined, { numeric: true });
    })
    .filter((item) => {
      const artifactKey = marketplaceArtifactKey(item);
      if (seen.has(artifactKey)) return false;
      seen.add(artifactKey);
      return true;
    })
    .map((item) => ({ ...publicMarketplaceSkill(item, registry, { includeYanked: true }), publishedByUser: true }));
};

const automaticMarketplaceTrustLevel = (entry = {}) => entry.sandboxVerified === true
  && entry.sandboxVerifiedVersion === entry.activeVersion ? "verified" : "community";

const buildManagedSkillCatalog = async ({ shensiRoot = "" } = {}) => {
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  await pruneExpiredSkillTrash(root, registry);
  if (await syncOfficialManagedSkillSnapshots(root, registry, shensiRoot)) await writeRegistry(root, registry);
  const fixedGroups = FIXED_SKILL_SLOT_GROUPS.map((group) => ({ ...group }));
  const customGroups = registry.customSlotGroups.map((group) => publicCustomGroup(group, registry));
  const fixedSlots = listFixedSkillSlots();
  const customSlots = registry.customSlots.map((slot) => publicCustomSlot(slot, registry)).sort((left, right) => (
    String(left.parentGroupId || "").localeCompare(String(right.parentGroupId || ""), "en-US")
    || Number(left.order) - Number(right.order)
    || Number(left.createdAt) - Number(right.createdAt)
    || left.name.localeCompare(right.name, "zh-CN")
    || left.id.localeCompare(right.id, "en-US")
  ));
  await Promise.all(registry.skills.map((entry) => ensureStandardSkillPackage(root, entry)));
  const remoteMarketplace = await readRemoteMarketplace();
  const localMarketplaceItems = marketplaceCatalogItems(registry).map((item) => publicMarketplaceSkill(item, registry));
  return {
    root,
    builtins: listBuiltinSkills(),
    fixedSlots,
    slotChains: FIXED_SKILL_SLOT_CHAINS.map((chain) => ({
      ...chain,
      workspaceModes: [...chain.workspaceModes],
      stages: chain.stages.map((stage) => ({
        ...stage,
        slotIds: [...stage.slotIds],
        groupIds: [...stage.groupIds],
        customCapabilities: [...stage.customCapabilities],
      })),
    })),
    slotGroups: [...fixedGroups, ...customGroups],
    user: managedPersonalSkillCatalog(registry),
    importProcessor: COMPOSITE_SKILL_PROCESSOR,
    capabilityAssets: (registry.capabilityAssets ?? [])
      .map((asset) => publicCapabilityAsset(asset, registry))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
    customSlots,
    capabilityTemplate: publicCapabilityTemplateState(registry.capabilityTemplate),
    officialCapabilityTemplate: createInitialCapabilityTemplate(),
    routeRevision: registry.routeRevision,
    routeTopology: compileRouteTopology(registry, { fixedSlots, customSlots }),
    routeDocument: publicRouteDocumentState(registry.routeDocument),
    marketplace: {
      connected: remoteMarketplace.connected === true,
      mode: remoteMarketplace.mode,
      automaticTrust: true,
      message: remoteMarketplace.connected
        ? `${remoteMarketplace.message} 当前桌面端仅接通签名目录与下载；账号发布、评分和下架仍保持本地，不得显示为云端成功。`
        : `当前使用本地 Skill 广场目录；${remoteMarketplace.message}。信任等级由软件自动评定，无需人工审核。`,
      health: remoteMarketplace.health,
      trustLevels: SKILL_TRUST_LEVELS,
      supportedSources: SKILL_SOURCE_TYPES,
      limits: {
        maxSkillSourceBytes: MAX_SKILL_SOURCE_BYTES,
        maxSkillPackageBytes: MAX_SKILL_PACKAGE_BYTES,
        maxCapabilityAssetBytes: MAX_CAPABILITY_ASSET_BYTES,
        packageFormat: "shensi-skill-package-v1",
        capabilityPackageFormat: CAPABILITY_ASSET_PACKAGE_FORMAT,
        storageBackend: remoteMarketplace.connected ? "signed_object_storage" : "local_filesystem",
        cloudUploadEnabled: remoteMarketplace.capabilities?.publish === true,
        cloudDownloadEnabled: remoteMarketplace.capabilities?.download === true,
      },
      items: [
        ...localMarketplaceItems,
        ...(remoteMarketplace.remoteItems ?? []).filter((item) => (
          (item.assetType || "skill") === "skill"
          && item.trustLevel !== "official"
          && item.sourceType !== "official"
        )),
      ],
      myPublications: marketplaceOwnedCatalogItems(registry),
      submissions: (registry.marketplaceSubmissions ?? [])
        .filter((item) => item.trustLevel !== "official" && item.sourceType !== "official")
        .map(publicMarketplaceSubmission),
    },
  };
};

export const listManagedSkills = ({ shensiRoot = "" } = {}) => {
  const requestKey = String(shensiRoot || "").trim();
  const pending = managedCatalogInFlight.get(requestKey);
  if (pending) {
    skillStoreCacheMetrics.catalogJoins += 1;
    return pending;
  }
  const request = buildManagedSkillCatalog({ shensiRoot }).finally(() => {
    if (managedCatalogInFlight.get(requestKey) === request) managedCatalogInFlight.delete(requestKey);
  });
  managedCatalogInFlight.set(requestKey, request);
  return request;
};

export const loadMarketplaceSkill = async ({ id, shensiRoot = "" } = {}) => {
  if (String(id || "").startsWith("remote:")) {
    const downloaded = await downloadRemoteMarketplaceArtifact(id);
    const artifact = downloaded.artifact;
    if (artifact.assetType === "skill") {
      const parsedPackage = parseSkillPackage(downloaded.bytes);
      assertRemoteMarketplaceSkillIdentity({ artifactId: artifact.artifactId, skillId: parsedPackage.metadata.id });
      const parsed = parseSkillMarkdown(parsedPackage.source);
      const metadata = normalizeSkillMetadata(parsed.metadata, { heading: parsed.heading });
      return {
        id,
        remote: true,
        assetType: "skill",
        name: metadata.name,
        author: metadata.author,
        version: artifact.version,
        description: metadata.description,
        capabilities: metadata.capabilities,
        workspaceModes: metadata.workspaceModes,
        capabilityBoundary: metadata.capabilityBoundary,
        trustLevel: artifact.trustLevel === "official" ? "official" : artifact.trustLevel === "verified" ? "verified" : "community",
        sourceLabel: "神思 Skill 广场",
        content: parsedPackage.source,
        packageFiles: parsedPackage.packageFiles.map((file) => file.path),
      };
    }
    let packagePayload;
    try { packagePayload = JSON.parse(downloaded.bytes.toString("utf8")); } catch { throw new Error("远程能力资产包不是有效 JSON"); }
    const payload = normalizeCapabilityAssetPayload(packagePayload.payload, artifact.assetType);
    const rootNode = capabilityTemplateNode(payload.bundle, payload.rootType, payload.rootId);
    return {
      id,
      remote: true,
      assetType: artifact.assetType,
      name: String(packagePayload.name || rootNode?.name || artifact.artifactId),
      author: String(packagePayload.author || "广场发布者"),
      version: artifact.version,
      description: String(packagePayload.description || rootNode?.description || ""),
      trustLevel: artifact.trustLevel === "official" ? "official" : artifact.trustLevel === "verified" ? "verified" : "community",
      sourceLabel: "神思 Skill 广场",
      payload,
      includedSkills: packagePayload.includedSkills ?? [],
      nodeCount: payload.bundle.groups.length + payload.bundle.modules.length,
      slotCount: payload.bundle.modules.reduce((total, module) => total + module.slots.length, 0),
      relationType: rootNode?.relationType || "parallel",
    };
  }
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const item = marketplaceAllItems(registry).find((candidate) => candidate.id === String(id ?? ""))
    ?? marketplaceSubmissionItems(registry).find((candidate) => candidate.id === String(id ?? ""));
  if (!item) throw new Error("广场项目不存在");
  if (marketplaceAssetType(item) !== "skill") {
    const payload = normalizeCapabilityAssetPayload(item.payload, marketplaceAssetType(item));
    const rootNode = capabilityTemplateNode(payload.bundle, payload.rootType, payload.rootId);
    return {
      ...publicMarketplaceSkill(item, registry),
      payload,
      includedSkills: capabilityIncludedSkills(payload, registry, item.includedSkills),
      capabilityBoundary: "只定义可被任务路由调动的能力结构，不获得文件、正史、记忆或落盘权限。",
      nodeCount: payload.bundle.groups.length + payload.bundle.modules.length,
      slotCount: payload.bundle.modules.reduce((total, module) => total + module.slots.length, 0),
      relationType: rootNode?.relationType || "parallel",
    };
  }
  if (item.localPreview) {
    const entry = registry.skills.find((skill) => skill.id === item.skillId);
    if (!entry) throw new Error("本地广场 Skill 源文件不可用");
    const loaded = await loadEntryVersion(root, entry, item.version);
    if (item.hash && loaded.versionRecord.hash !== item.hash) throw new Error("本地广场 Skill 版本校验失败");
    return { ...publicMarketplaceSkill(item, registry), content: loaded.content };
  }
  let content = String(item.installContent ?? "");
  const relativeSource = MARKETPLACE_CONTENT_SOURCES[item.id];
  if (!content && relativeSource && shensiRoot) {
    const sourcePath = resolve(shensiRoot, ...relativeSource.split("/"));
    const allowedRoot = resolve(shensiRoot);
    if (isInside(sourcePath, allowedRoot)) content = await readSkillVersionSource(sourcePath).catch(() => "");
  }
  if (!content) content = `# ${item.name}\n\n${item.description}\n\n> 此官方 Skill 的完整随包内容在当前运行环境中不可读取。`;
  if (item.hash && item.installContent && hashText(content) !== item.hash) throw new Error("广场 Skill 发布快照校验失败");
  return { ...publicMarketplaceSkill(item, registry), content };
};

const marketplaceContentForItem = async (item = {}, shensiRoot = "") => {
  let content = String(item.installContent ?? "");
  const relativeSource = MARKETPLACE_CONTENT_SOURCES[item.id];
  if (!content && relativeSource && shensiRoot) {
    const sourcePath = resolve(shensiRoot, ...relativeSource.split("/"));
    const allowedRoot = resolve(shensiRoot);
    if (isInside(sourcePath, allowedRoot)) content = await readSkillVersionSource(sourcePath).catch(() => "");
  }
  if (item.hash && item.installContent && hashText(content) !== item.hash) throw new Error("广场 Skill 发布快照校验失败");
  return content;
};

const bundledFixedSkillContent = async (item = {}, shensiRoot = "") => {
  const relativeSource = String(item.bundledSource || "").trim();
  if (!relativeSource || !shensiRoot) return "";
  const sourcePath = resolve(shensiRoot, ...relativeSource.split("/"));
  const allowedRoot = resolve(shensiRoot);
  if (!isInside(sourcePath, allowedRoot)) throw new Error("内置 Skill 来源越出神思能力包");
  return readSkillVersionSource(sourcePath).catch(() => "");
};

const skillPublicationFingerprint = ({ metadata = {}, body = "" } = {}) => hashText(JSON.stringify({
  body: String(body || "").trim(),
  description: metadata.description || "",
  capabilityBoundary: metadata.capabilityBoundary || "",
  capabilities: metadata.capabilities ?? [],
  workspaceModes: metadata.workspaceModes ?? [],
  artifactTypes: metadata.artifactTypes ?? [],
  inputRequirements: metadata.inputRequirements ?? [],
  outputContract: metadata.outputContract || "",
  triggerKeywords: metadata.triggerKeywords ?? [],
  triggerConditions: metadata.triggerConditions ?? [],
}));

const officialSkillById = (id = {}) => {
  const requested = canonicalBuiltinSkillId(id);
  const marketplaceItem = OFFICIAL_MARKETPLACE_SKILLS.find((item) => item.id === requested || item.skillId === requested || item.managedSkillId === requested);
  if (marketplaceItem) return { type: "marketplace", item: marketplaceItem };
  const fixedSlot = listFixedSkillSlots().find((slot) => slot.id === requested);
  if (fixedSlot) return { type: "fixed", item: fixedSlot };
  const builtin = listBuiltinSkills().find((skill) => skill.id === requested);
  if (builtin) return { type: "builtin", item: builtin };
  return null;
};

const synthesizedOfficialSkillContent = (skill = {}) => {
  const skillId = String(skill.skillId || skill.id || "").replace(/^(?:official|builtin):/, "official.");
  const capabilities = [...new Set([...(skill.capabilities ?? []), ...(skill.replacementCapabilities ?? [])])]
    .filter((capability) => allowedSkillCapabilities("general").includes(capability));
  const modes = skill.workspaceModes?.length ? skill.workspaceModes : ["general"];
  const boundary = skill.capabilityBoundary || `只在“${skill.name}”官方插槽授权能力内生效；不接管任务路由、资料权限、正史裁决或记忆更新。`;
  return `---
schema_version: 2
id: ${yamlString(skillId)}
name: ${yamlString(skill.name || "官方 Skill")}
version: "1.0.0"
author: "神思团队"
description: ${yamlString(skill.description || "神思官方内嵌 Skill。")}
source: "official"
workspace_modes:${yamlList(modes)}
capabilities:${yamlList(capabilities.length ? capabilities : ["auxiliary_advisor"])}
capability_boundary: ${yamlString(boundary)}
---

# ${skill.name || "官方 Skill"}

## 用途

${skill.description || "神思官方内嵌 Skill。"}

## 能力边界

${boundary}

## 授权能力

${(capabilities.length ? capabilities : ["auxiliary_advisor"]).map((capability) => `- ${capability}`).join("\n")}

## 使用方式

- 仅在绑定插槽授权的能力范围内作为候选生成或方法约束生效。
- 不读取未授权资料，不变更正史、记忆或索引。
- 可直接编辑并保存为新的本地历史版本；需要建立独立分支时，可另行复制为可编辑副本。
`;
};

export const loadOfficialSkill = async ({ id, shensiRoot = "" } = {}) => {
  const found = officialSkillById(id);
  if (!found) throw new Error("官方 Skill 不存在");
  const content = found.type === "marketplace"
    ? await marketplaceContentForItem(found.item, shensiRoot)
    : await bundledFixedSkillContent(found.item, shensiRoot);
  const item = found.item;
  const resolvedContent = content || synthesizedOfficialSkillContent(item);
  const bundledRelativeSource = item.bundledSource || (found.type === "marketplace" ? MARKETPLACE_CONTENT_SOURCES[item.id] : "");
  const sourcePath = bundledRelativeSource && shensiRoot
    ? resolve(shensiRoot, ...String(bundledRelativeSource).split("/"))
    : "";
  if (sourcePath && !isInside(sourcePath, resolve(shensiRoot))) throw new Error("内置 Skill 来源越出神思能力包");
  const skill = {
    id: item.id,
    skillId: item.skillId || item.id,
    name: item.name,
    author: item.author || "神思团队",
    version: item.version || "内置",
    description: item.description,
    capabilityBoundary: item.capabilityBoundary || `只在“${item.name}”官方插槽授权能力内生效；可信内核能力不可替换。`,
    origin: "developer",
    trustLevel: "official",
    sourceType: "official",
    sourceLabel: item.sourceLabel || (found.type === "marketplace" ? "神思官方目录" : "神思官方内嵌固定插槽"),
    workspaceModes: item.workspaceModes ?? ["general"],
    capabilities: item.capabilities ?? item.replacementCapabilities ?? [],
    replacementCapabilities: item.replacementCapabilities ?? item.capabilities ?? [],
    content: resolvedContent,
    contentHash: hashText(resolvedContent),
    sourcePath,
    testStatus: "passed",
  };
  return skill;
};

const uniqueCopySkillId = (registry = {}, sourceId = "") => {
  const base = `copy.${String(sourceId).replace(/^(?:user:|official:|builtin:)/, "").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-|-$/g, "").slice(0, 64) || "official-skill"}`;
  const existing = new Set((registry.skills ?? []).map((entry) => entry.id));
  if (!existing.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error("无法生成不冲突的 Skill 副本 ID");
};

const safeSemanticVersion = (value = "1.0.0") => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(value || ""))
  ? String(value) : "1.0.0";

const skillSourceDescriptor = (skill = {}) => {
  const parsed = parseSkillMarkdown(skill.content || synthesizedOfficialSkillContent(skill));
  const metadata = normalizeSkillMetadata(parsed.metadata, { heading: parsed.heading });
  const capabilities = (skill.capabilities?.length ? skill.capabilities : metadata.capabilities)
    .filter((capability) => allowedSkillCapabilities("general").includes(capability));
  return {
    ...metadata,
    name: skill.name || metadata.name,
    author: skill.author || metadata.author,
    description: skill.description || metadata.description,
    capabilityBoundary: skill.capabilityBoundary || metadata.capabilityBoundary,
    capabilities: capabilities.length ? capabilities : ["auxiliary_advisor"],
    workspaceModes: skill.workspaceModes?.length ? skill.workspaceModes : metadata.workspaceModes,
    body: parsed.body || `# ${skill.name || metadata.name || "Skill"}`,
  };
};

const editableSkillSource = ({
  skill = {}, localId = "", name = "", version = "1.0.0", source = "derived-copy",
  prototypeId = "", prototypeName = "", prototypeFingerprint = "", derivativeCopy = false,
  upstreamId = "", upstreamVersion = "",
} = {}) => {
  const metadata = skillSourceDescriptor(skill);
  return `---
schema_version: 2
id: ${yamlString(localId)}
name: ${yamlString(name || metadata.name)}
version: ${yamlString(safeSemanticVersion(version))}
author: ${yamlString(metadata.author)}
description: ${yamlString(metadata.description)}
source: ${yamlString(source)}
prototype_id: ${yamlString(prototypeId)}
prototype_name: ${yamlString(prototypeName || metadata.name)}
prototype_fingerprint: ${yamlString(prototypeFingerprint)}
derivative_copy: ${derivativeCopy ? "true" : "false"}
${upstreamId ? `upstream_id: ${yamlString(upstreamId)}\nupstream_version: ${yamlString(upstreamVersion)}\n` : ""}change_summary: ""
workspace_modes:${yamlList(metadata.workspaceModes)}
capabilities:${yamlList(metadata.capabilities)}
capability_boundary: ${yamlString(metadata.capabilityBoundary)}
role: ${yamlString(metadata.role)}
artifact_types:${yamlList(metadata.artifactTypes)}
input_requirements:${yamlList(metadata.inputRequirements)}
output_contract: ${yamlString(metadata.outputContract)}
stages:${yamlList(metadata.stages)}
slots:${yamlList(metadata.slots)}
conflict_policy: ${yamlString(metadata.conflictPolicy)}
fallback: ${yamlString(metadata.fallback)}
trigger_keywords:${yamlList(metadata.triggerKeywords)}
trigger_conditions:${yamlList(metadata.triggerConditions)}
---

${metadata.body}
`;
};

const officialCopySource = ({ skill = {}, copyId = "" } = {}) => {
  const metadata = skillSourceDescriptor(skill);
  return editableSkillSource({
    skill,
    localId: copyId,
    name: `${metadata.name || "官方 Skill"} 副本`,
    version: "1.0.0",
    prototypeId: skill.skillId || skill.id,
    prototypeName: metadata.name,
    prototypeFingerprint: skillPublicationFingerprint({ metadata, body: metadata.body }),
    derivativeCopy: true,
  });
};

export const copyOfficialSkill = async ({ id, shensiRoot = "" } = {}) => {
  const skill = await loadOfficialSkill({ id, shensiRoot });
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const copyId = uniqueCopySkillId(registry, skill.skillId || skill.id);
  const installed = await installSkillSource({
    content: officialCopySource({ skill, copyId }),
    origin: "imported",
    sourceType: "local_folder",
    sourceLabel: `官方 Skill 副本：${skill.name}`,
  });
  return { ...installed, sourceSkill: { id: skill.id, name: skill.name } };
};

const loadSkillCopySource = async ({ id, kind = "mine", shensiRoot = "" } = {}) => {
  if (kind === "official") return loadOfficialSkill({ id, shensiRoot });
  if (kind === "marketplace") {
    const skill = await loadMarketplaceSkill({ id, shensiRoot });
    if ((skill.assetType || "skill") !== "skill") throw new Error("该广场项目不是 Skill");
    return skill;
  }
  return loadManagedSkill({ id, includeContent: true });
};

export const copyManagedSkillForEditing = async ({ id, kind = "mine", shensiRoot = "" } = {}) => {
  const skill = await loadSkillCopySource({ id, kind, shensiRoot });
  const metadata = skillSourceDescriptor(skill);
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const sourceId = skill.skillId || skill.id || id;
  const copyId = uniqueCopySkillId(registry, sourceId);
  const installed = await installSkillSource({
    content: editableSkillSource({
      skill,
      localId: copyId,
      name: `${metadata.name || "Skill"} 副本`,
      version: "1.0.0",
      prototypeId: sourceId,
      prototypeName: metadata.name,
      prototypeFingerprint: skillPublicationFingerprint({ metadata, body: metadata.body }),
      derivativeCopy: true,
    }),
    origin: "imported",
    sourceType: "local_folder",
    sourceLabel: `可编辑副本：${metadata.name}`,
  });
  return { ...installed, sourceSkill: { id: sourceId, name: metadata.name, kind } };
};

const editableOfficialSkillId = (sourceId = "") => `official.edit.${String(sourceId)
  .replace(/^(?:official:|builtin:|user:)/, "")
  .replace(/[^a-z0-9._-]+/gi, "-")
  .replace(/^-|-$/g, "")
  .slice(0, 58) || "skill"}`;

const availableUpstreamVersion = (entry = {}, requestedVersion = "1.0.0") => {
  const base = safeSemanticVersion(requestedVersion);
  const existing = new Set((entry.versions ?? []).map((version) => String(version.version)));
  if (!existing.has(base)) return base;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = base.includes("-") ? `${base}.upstream.${index}` : `${base}-upstream.${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error("官方 Skill 上游版本号冲突过多，无法追加历史");
};

const appendOfficialSkillSnapshot = async ({ root, registry, entry, skill } = {}) => {
  const metadata = skillSourceDescriptor(skill);
  const upstreamFingerprint = skillPublicationFingerprint({ metadata, body: metadata.body });
  const requestedUpstreamVersion = String(skill.version || "1.0.0");
  if ((entry.versions ?? []).some((version) => version.upstreamFingerprint === upstreamFingerprint
    && String(version.upstreamVersion || version.version) === requestedUpstreamVersion)) {
    entry.upstreamVersion = String(skill.version || entry.upstreamVersion || "");
    return false;
  }
  const upstreamVersion = requestedUpstreamVersion;
  const version = availableUpstreamVersion(entry, upstreamVersion);
  const source = editableSkillSource({
    skill,
    localId: entry.id,
    name: metadata.name,
    version,
    source: "official-edit",
    prototypeId: skill.skillId || skill.id,
    prototypeName: metadata.name,
    prototypeFingerprint: upstreamFingerprint,
    derivativeCopy: false,
    upstreamId: skill.skillId || skill.id,
    upstreamVersion,
  });
  const installedAt = Date.now();
  await atomicWrite(versionPath(root, entry.id, version), source);
  skillVersionReadCache.delete(versionPath(root, entry.id, version));
  entry.versions = [...(entry.versions ?? []), {
    version,
    upstreamVersion,
    upstreamId: skill.skillId || skill.id,
    upstreamFingerprint,
    hash: hashText(source),
    installedAt,
    source: "downloaded",
    trustLevel: "official",
    sourceType: "official",
    testStatus: "passed",
    testSummary: "官方 Skill 上游版本已同步到本地历史。",
    lastTestedAt: installedAt,
    compositeDefinition: null,
  }];
  entry.upstreamVersion = upstreamVersion;
  entry.upstreamFingerprint = upstreamFingerprint;
  return true;
};

const syncOfficialManagedSkillSnapshots = async (root, registry, shensiRoot = "") => {
  let changed = false;
  for (const entry of registry.skills ?? []) {
    if (!entry.upstreamId || entry.upstreamType === "marketplace" && !shensiRoot) continue;
    const skill = await loadOfficialSkill({ id: entry.upstreamId, shensiRoot }).catch(() => null);
    if (!skill) continue;
    if (await appendOfficialSkillSnapshot({ root, registry, entry, skill })) changed = true;
  }
  return changed;
};

const rebindOfficialSkillToManaged = (registry, sourceIds = [], managedId = "") => {
  const requested = new Set(unique(sourceIds));
  const current = registry.capabilityTemplate.current;
  const matched = current.modules.some((module) => module.slots.some((slot) => !slot.kernelManaged && requested.has(slot.skillId)));
  if (!matched) return false;
  const next = normalizeCapabilityTemplate(registry.capabilityTemplate.current);
  for (const module of next.modules) {
    for (const slot of module.slots) {
      if (slot.kernelManaged || !requested.has(slot.skillId)) continue;
      slot.skillId = `user:${managedId}`;
      slot.compositeChildId = "";
    }
  }
  const validation = validateCapabilityTemplate(next);
  if (!validation.valid) throw new Error(`官方 Skill 编辑版本装配失败：${validation.errors.join("；")}`);
  registry.capabilityTemplate.current = validation.bundle;
  registry.capabilityTemplate = normalizeCapabilityTemplateState(registry.capabilityTemplate, {
    customSlots: registry.customSlots,
    customSlotGroups: registry.customSlotGroups,
  });
  bumpRouteRevision(registry, { reason: "skill_changed", sourceScopeType: "skill", sourceScopeId: managedId });
  return true;
};

export const materializeOfficialSkillForEditing = async ({ id, shensiRoot = "" } = {}) => {
  const found = officialSkillById(id);
  if (!found) throw new Error("官方 Skill 不存在");
  const skill = await loadOfficialSkill({ id, shensiRoot });
  const metadata = skillSourceDescriptor(skill);
  const managedId = editableOfficialSkillId(skill.skillId || skill.id);
  let root = await ensureSkillStore();
  let registry = await readRegistry(root);
  let entry = registry.skills.find((candidate) => candidate.id === managedId);
  if (!entry) {
    const upstreamVersion = safeSemanticVersion(skill.version);
    const fingerprint = skillPublicationFingerprint({ metadata, body: metadata.body });
    await installSkillSource({
      content: editableSkillSource({
        skill,
        localId: managedId,
        name: metadata.name,
        version: upstreamVersion,
        source: "official-edit",
        prototypeId: skill.skillId || skill.id,
        prototypeName: metadata.name,
        prototypeFingerprint: fingerprint,
        derivativeCopy: false,
        upstreamId: skill.skillId || skill.id,
        upstreamVersion: String(skill.version || upstreamVersion),
      }),
      origin: "downloaded",
      sourceType: "official",
      sourceLabel: `官方 Skill 可编辑版本：${metadata.name}`,
    });
    ({ root, registry, entry } = await findManagedEntry(managedId));
    entry.upstreamType = found.type;
    entry.upstreamId = skill.skillId || skill.id;
    entry.upstreamVersion = String(skill.version || upstreamVersion);
    entry.upstreamFingerprint = fingerprint;
    entry.origin = "downloaded";
    entry.trustLevel = "official";
    entry.sourceType = "official";
    entry.sourceLabel = `官方 Skill 可编辑版本：${metadata.name}`;
    entry.testStatus = "passed";
    entry.testSummary = "官方 Skill 已通过内置静态合同与安全校验。";
    const activeRecord = entry.versions.find((version) => version.version === entry.activeVersion);
    if (activeRecord) Object.assign(activeRecord, {
      upstreamVersion: entry.upstreamVersion,
      upstreamId: entry.upstreamId,
      upstreamFingerprint: fingerprint,
      trustLevel: "official",
      sourceType: "official",
      testStatus: "passed",
      testSummary: entry.testSummary,
    });
  } else {
    entry.upstreamType ||= found.type;
    entry.upstreamId ||= skill.skillId || skill.id;
    await appendOfficialSkillSnapshot({ root, registry, entry, skill });
  }
  rebindOfficialSkillToManaged(registry, unique([id, skill.id, skill.skillId]), entry.id);
  await writeRegistry(root, registry);
  await rm(join(versionRoot(root, entry.id, entry.activeVersion), "manifest.json"), { force: true });
  await ensureStandardSkillPackage(root, entry);
  return { skill: publicSkill(entry), routeRevision: registry.routeRevision };
};

export const setMarketplaceSkillRating = async ({ id, rating, comment = "", profile = {} } = {}) => {
  const value = Number(rating);
  if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error("评分必须为 1-5 的整数");
  const reviewText = String(comment || "").trim().slice(0, 1_000);
  if (reviewText.length < 2) throw new Error("请填写至少 2 个字的文字点评");
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const item = marketplaceCatalogItems(registry).find((candidate) => candidate.id === String(id ?? ""));
  if (!item) throw new Error("广场项目不存在");
  registry.marketplaceRatings = { ...(registry.marketplaceRatings ?? {}), [item.id]: value };
  const requestedAuthorId = String(profile?.accountId || "").trim();
  const authorId = !requestedAuthorId || requestedAuthorId === "--" ? "local-user" : requestedAuthorId.slice(0, 120);
  const reviewId = `review:${item.id}:${authorId}`;
  const reviews = [...(registry.marketplaceReviews?.[item.id] ?? [])];
  const existing = reviews.find((review) => review.id === reviewId);
  const now = Date.now();
  const record = {
    id: reviewId,
    authorId,
    authorName: String(profile?.nickname || "神思用户").trim().slice(0, 80) || "神思用户",
    avatarUrl: String(profile?.avatarUrl || "").trim().slice(0, 500),
    rating: value,
    comment: reviewText,
    createdAt: Number(existing?.createdAt) || now,
    updatedAt: now,
  };
  if (existing) Object.assign(existing, record);
  else reviews.push(record);
  registry.marketplaceReviews = { ...(registry.marketplaceReviews ?? {}), [item.id]: reviews.slice(-200) };
  await writeRegistry(root, registry);
  return publicMarketplaceSkill(item, registry);
};

const officialSkillPublicationDetails = async () => {
  const ids = unique([
    ...OFFICIAL_MARKETPLACE_SKILLS.flatMap((skill) => [skill.id, skill.skillId]),
    ...BUILTIN_SKILLS.map((skill) => skill.id),
  ]);
  return (await Promise.all(ids.map((id) => loadOfficialSkill({ id }).catch(() => null))))
    .filter((skill, index, skills) => skill && skills.findIndex((candidate) => candidate?.id === skill.id) === index);
};

export const submitMarketplaceSkill = async ({ id } = {}) => {
  const { root, registry, entry } = await findManagedEntry(id);
  const publisherIsAdmin = registry.localPublisher?.role === "admin";
  if (entry.testStatus !== "passed") throw new Error("只有测试通过的 Skill 才能发布到广场");
  if (!publisherIsAdmin && normalizedTrustLevel(entry.trustLevel, entry.origin) === "official") throw new Error("普通用户不能重复上传官方 Skill；微调后必须重命名，并填写原型与具体改动说明");
  const loaded = await loadEntryVersion(root, entry, entry.activeVersion);
  const semanticHash = skillPublicationFingerprint(loaded);
  if (!publisherIsAdmin && entry.prototypeId) {
    if (!entry.prototypeName || !entry.changeSummary) throw new Error("衍生 Skill 必须保留原型名称并填写具体改动说明");
    if ([entry.prototypeName, `${entry.prototypeName} 副本`].includes(entry.name)) throw new Error("衍生 Skill 必须重命名后才能分享到广场");
    if (entry.prototypeFingerprint && entry.prototypeFingerprint === semanticHash) {
      throw new Error("这个副本只修改了名称，实际能力内容与原型完全相同；必须修改内容或能力结构，并填写具体改动说明后才能分享到广场");
    }
    const prototype = await loadOfficialSkill({ id: entry.prototypeId }).catch(() => null);
    if (prototype) {
      const prototypeBody = parseSkillMarkdown(prototype.content || "").body.trim();
      const implementationChanged = loaded.body.trim() !== prototypeBody
        || entry.description !== prototype.description
        || entry.capabilityBoundary !== prototype.capabilityBoundary;
      if (!implementationChanged) throw new Error("衍生 Skill 尚未修改实际能力内容，不能重复分享到广场");
    }
  }
  const officialSkills = publisherIsAdmin ? [] : await officialSkillPublicationDetails();
  if (!publisherIsAdmin && !entry.prototypeId && officialSkills.some((skill) => skill.name.trim().toLocaleLowerCase() === entry.name.trim().toLocaleLowerCase())) {
    throw new Error("普通用户不能发布与官方 Skill 同名的内容；请重新命名，并填写原型与具体改动说明");
  }
  const scan = scanSkillSource({ content: loaded.content, metadata: { ...loaded.metadata, frontmatter: parseSkillMarkdown(loaded.content).frontmatter } });
  const staticTest = skillTestSummary({ skill: loaded.metadata, body: loaded.body, scan });
  if (!staticTest.passed) throw new Error(`Skill 自动安全检查未通过：${staticTest.summary}`);
  const trustLevel = automaticMarketplaceTrustLevel(entry);
  const existing = (registry.marketplaceSubmissions ?? []).find((submission) => submission.skillId === entry.id && submission.version === entry.activeVersion);
  const duplicateName = (registry.marketplaceSubmissions ?? []).find((submission) => submission.status === "published"
    && submission.skillId !== entry.id
    && submission.name.trim().toLocaleLowerCase() === entry.name.trim().toLocaleLowerCase());
  if (!publisherIsAdmin && duplicateName) {
    throw new Error(`广场已存在同名 Skill：${duplicateName.name}；请重新命名，并在衍生内容中写清原型、具体改动和差异`);
  }
  if (!publisherIsAdmin && officialSkills.some((skill) => {
    const parsed = parseSkillMarkdown(skill.content || "");
    return skillPublicationFingerprint({ metadata: skill, body: parsed.body }) === semanticHash;
  })) {
    throw new Error("该 Skill 与官方原型内容相同，不能重复发布；微调后必须重新命名，并写清具体改动和与原型的区别");
  }
  const duplicate = (registry.marketplaceSubmissions ?? []).find((submission) => (submission.semanticHash || submission.hash) === semanticHash && submission.id !== existing?.id);
  if (duplicate) throw new Error(`广场已存在内容完全相同的 Skill：${duplicate.name || duplicate.skillId}`);
  const publisher = publisherFields({
    authority: registry.localPublisher,
    publication: {
      ...existing,
      author: entry.author,
      sourceType: entry.sourceType || inferredSourceType(entry.source, entry.origin),
      sourceLabel: entry.sourceLabel || entry.source || "本地 Skill 库",
    },
    verified: trustLevel === "verified",
  });
  const publication = {
    id: existing?.id || `publication:${entry.id}@${entry.activeVersion}`,
    skillId: entry.id,
    name: entry.name,
    author: publisher.author,
    version: entry.activeVersion,
    description: entry.description,
    hash: loaded.versionRecord.hash,
    semanticHash,
    content: loaded.content,
    trustLevel: publisher.trustLevel,
    sourceType: publisher.sourceType,
    sourceLabel: publisher.sourceLabel,
    publisherAccountId: publisher.publisherAccountId,
    publisherRole: publisher.publisherRole,
    capabilities: entry.capabilities ?? [],
    workspaceModes: entry.workspaceModes ?? [],
    status: "published",
    publishedAt: existing?.publishedAt || Date.now(),
    yankedAt: 0,
  };
  if (existing) Object.assign(existing, publication);
  else registry.marketplaceSubmissions = [...(registry.marketplaceSubmissions ?? []), publication];
  await writeRegistry(root, registry);
  const result = publicMarketplaceSubmission(publication);
  return {
    publication: result,
    submission: result,
    alreadyPublished: Boolean(existing),
    alreadySubmitted: Boolean(existing),
  };
};

export const unpublishMarketplaceItem = async ({ id } = {}) => {
  const requestedId = String(id || "").trim();
  if (!requestedId) throw new Error("缺少要下架的广场版本");
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const publication = [
    ...(registry.marketplaceSubmissions ?? []),
    ...(registry.capabilityMarketplaceSubmissions ?? []),
  ].find((entry) => entry.id === requestedId);
  if (!publication) throw new Error("只能下架当前账号发布的内容");
  if (publication.status === "yanked") {
    return { publication: publicMarketplaceSubmission(publication), alreadyUnpublished: true };
  }
  publication.status = "yanked";
  publication.yankedAt = Date.now();
  await writeRegistry(root, registry);
  return { publication: publicMarketplaceSubmission(publication), alreadyUnpublished: false };
};

export const deleteMarketplacePublication = async ({ id } = {}) => {
  const requestedId = String(id || "").trim();
  if (!requestedId) throw new Error("缺少要删除的广场版本");
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const skillPublication = (registry.marketplaceSubmissions ?? []).find((entry) => entry.id === requestedId);
  const capabilityPublication = (registry.capabilityMarketplaceSubmissions ?? []).find((entry) => entry.id === requestedId);
  const publication = skillPublication || capabilityPublication;
  if (!publication) throw new Error("只有创作者可以删除自己发布的云端版本");
  registry.marketplaceSubmissions = (registry.marketplaceSubmissions ?? []).filter((entry) => entry.id !== requestedId);
  registry.capabilityMarketplaceSubmissions = (registry.capabilityMarketplaceSubmissions ?? []).filter((entry) => entry.id !== requestedId);
  await writeRegistry(root, registry);
  return { deleted: true, publication: publicMarketplaceSubmission(publication) };
};

const versionRoot = (root, id, version) => {
  const target = resolve(root, USER_DIRECTORY, id, version);
  const userRoot = resolve(root, USER_DIRECTORY);
  if (!isInside(target, userRoot)) throw new Error("Skill 路径越界");
  return target;
};

const versionPath = (root, id, version) => {
  return join(versionRoot(root, id, version), "SKILL.md");
};

const PACKAGE_DIRECTORIES = new Set(["references", "examples", "tests", "agents", "assets", "skills", "modules", "groups", "subskills"]);
const COMPOSITE_CONTAINER_DIRECTORIES = new Set(["skills", "modules", "groups", "subskills", "agents"]);
const EXECUTABLE_PACKAGE_FILE = /\.(?:exe|dll|com|bat|cmd|ps1|sh|js|mjs|cjs|py|rb|pl|php|jar|msi)$/i;

const normalizedPackagePath = (value = "") => String(value)
  .replaceAll("\\", "/")
  .replace(/^\.\//, "")
  .replace(/\/{2,}/g, "/");

const safePackageRelativePath = (value = "") => {
  const path = normalizedPackagePath(value);
  if (!path || path.startsWith("/") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..")) return false;
  if (["SKILL.md", "manifest.json"].includes(path)) return true;
  const [directory] = path.split("/");
  return PACKAGE_DIRECTORIES.has(directory) && path.length <= 240 && !EXECUTABLE_PACKAGE_FILE.test(path);
};

const packageSkillDefinition = (file) => {
  if (file.content.length > MAX_SKILL_SOURCE_BYTES) throw new Error(`子 Skill 不能超过 256 KB：${file.path}`);
  const source = file.content.toString("utf8").replace(/^\uFEFF/, "");
  const parsed = parseSkillMarkdown(source);
  const metadata = normalizeSkillMetadata(parsed.metadata, { heading: parsed.heading });
  const validation = validateSkillMetadata(metadata);
  if (!validation.valid) throw new Error(`子 Skill“${file.path}”格式无效：${validation.errors.join("；")}`);
  if (!parsed.body) throw new Error(`子 Skill“${file.path}”正文为空`);
  const scan = scanSkillSource({ content: source, metadata: { ...metadata, frontmatter: parsed.frontmatter } });
  if (!scan.safe) throw new Error(`子 Skill“${file.path}”安全扫描未通过：${scan.issues.filter((item) => item.severity === "fatal").map((item) => item.label).join("；")}`);
  return {
    path: file.path,
    source,
    body: parsed.body,
    metadata,
    compositeRole: String(parsed.metadata?.composite_role ?? parsed.metadata?.compositeRole ?? "").trim(),
  };
};

const parseSkillPackage = (bytes) => {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error("Skill 包为空");
  if (bytes.length > MAX_SKILL_PACKAGE_BYTES) throw new Error("单个 Skill 包不能超过 4 MB");
  const archiveEntries = unzipSelectedEntries(bytes, (name) => !/(?:^|\/)__MACOSX(?:\/|$)|(?:^|\/)\.DS_Store$/i.test(name));
  const skillFiles = archiveEntries.filter((entry) => /(?:^|\/)SKILL\.md$/i.test(normalizedPackagePath(entry.name)));
  if (!skillFiles.length) throw new Error("完整 Skill 包必须包含一个根 SKILL.md");
  const shallowestDepth = Math.min(...skillFiles.map((entry) => normalizedPackagePath(entry.name).split("/").length));
  const rootSkillFiles = skillFiles.filter((entry) => normalizedPackagePath(entry.name).split("/").length === shallowestDepth);
  if (rootSkillFiles.length !== 1) throw new Error("复合 Skill 包必须包含唯一的根 SKILL.md，不能并列多个总控入口");
  const skillArchivePath = normalizedPackagePath(rootSkillFiles[0].name);
  const prefix = skillArchivePath.slice(0, -"SKILL.md".length);
  const outsideRoot = archiveEntries.find((entry) => !normalizedPackagePath(entry.name).startsWith(prefix));
  if (outsideRoot) throw new Error(`Skill 包只能包含一个完整根目录：${outsideRoot.name}`);
  const files = archiveEntries.map((entry) => ({
    path: normalizedPackagePath(entry.name).startsWith(prefix) ? normalizedPackagePath(entry.name).slice(prefix.length) : "",
    content: entry.content,
  })).filter((entry) => entry.path);
  if (files.reduce((total, entry) => total + entry.content.length, 0) > MAX_SKILL_PACKAGE_BYTES) throw new Error("Skill 包展开后不能超过 4 MB");
  const unsupported = files.find((entry) => !safePackageRelativePath(entry.path));
  if (unsupported) throw new Error(`Skill 包含不支持或不安全的文件：${unsupported.path}`);
  const duplicatePaths = new Set();
  for (const file of files) {
    const key = file.path.toLowerCase();
    if (duplicatePaths.has(key)) throw new Error(`Skill 包包含重复文件：${file.path}`);
    duplicatePaths.add(key);
  }
  const source = files.find((entry) => entry.path.toLowerCase() === "skill.md")?.content.toString("utf8") || "";
  const parsed = parseSkillMarkdown(source);
  const metadata = normalizeSkillMetadata(parsed.metadata, { heading: parsed.heading });
  const manifestFile = files.find((entry) => entry.path.toLowerCase() === "manifest.json");
  let manifest = {};
  if (manifestFile) {
    try {
      manifest = JSON.parse(manifestFile.content.toString("utf8"));
    } catch {
      throw new Error("Skill 包的 manifest.json 不是有效 JSON");
    }
    if (manifest.id && String(manifest.id) !== metadata.id) throw new Error("manifest.json 与 SKILL.md 的 Skill ID 不一致");
    if (manifest.version && String(manifest.version) !== metadata.version) throw new Error("manifest.json 与 SKILL.md 的版本不一致");
  }
  const childSkills = files
    .filter((entry) => entry.path.toLowerCase() !== "skill.md" && /(?:^|\/)skill\.md$/i.test(entry.path))
    .map(packageSkillDefinition);
  const duplicateSkillId = childSkills.find((child, index) => childSkills.findIndex((candidate) => candidate.metadata.id === child.metadata.id) !== index);
  if (duplicateSkillId) throw new Error(`复合 Skill 包包含重复的子 Skill ID：${duplicateSkillId.metadata.id}`);
  return {
    source,
    metadata,
    manifest,
    childSkills,
    packageFiles: files.filter((entry) => !["skill.md", "manifest.json"].includes(entry.path.toLowerCase())),
  };
};

const compositeLabel = (value = "") => String(value || "能力")
  .replace(/[-_]+/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 80) || "能力";
const compositeManifestSettings = (manifest = {}) => manifest.composite || manifest.compositeSkill || manifest.capabilityStructure || {};
const compositeSemanticSegments = (path = "") => {
  const segments = normalizedPackagePath(path).split("/").slice(0, -1);
  if (COMPOSITE_CONTAINER_DIRECTORIES.has(String(segments[0] || "").toLowerCase())) segments.shift();
  return segments;
};

const compileCompositeSkillPackage = ({
  metadata,
  source,
  manifest = {},
  childSkills = [],
  sourceLabel = "本地 Skill 包",
  packageHash = "",
  confirmedRelations = [],
} = {}) => {
  if (!childSkills.length) return null;
  const assetId = `library:composite:${hashText(metadata.id).slice(0, 20)}`;
  const runtimeSkillId = `user:${metadata.id}`;
  const includedSkills = [];
  const tree = { path: "", children: new Map(), skills: [] };
  for (const child of childSkills) {
    const segments = compositeSemanticSegments(child.path);
    const containerSegments = segments.slice(0, -1);
    let cursor = tree;
    for (const segment of containerSegments) {
      if (!cursor.children.has(segment)) cursor.children.set(segment, { path: [...(cursor.path ? cursor.path.split("/") : []), segment].join("/"), children: new Map(), skills: [] });
      cursor = cursor.children.get(segment);
    }
    cursor.skills.push(child);
  }
  const modules = [];
  const groups = [];
  const relationDecisions = [];
  const relationScopeByNodeId = new Map();
  const orderedValues = (values, decision, refFor) => {
    const byRef = new Map(values.map((value) => [refFor(value), value]));
    return decision.orderedMembers.map((ref) => byRef.get(ref)).filter(Boolean);
  };
  const decideRelation = (scope) => {
    const decision = analyzeCompositeRelationScope({ manifest, scope, confirmedRelations });
    relationDecisions.push(decision);
    return decision;
  };
  const descriptorFor = (child) => {
    const descriptorId = `composite-child:${hashText(`${metadata.id}:${child.path}:${child.metadata.id}`).slice(0, 24)}`;
    includedSkills.push({
      skillId: descriptorId,
      runtimeSkillId,
      name: child.metadata.name,
      description: child.metadata.description,
      capabilityBoundary: child.metadata.capabilityBoundary || child.metadata.description,
      capabilities: child.metadata.capabilities,
      workspaceModes: child.metadata.workspaceModes,
      inputRequirements: child.metadata.inputRequirements,
      outputContract: child.metadata.outputContract,
      triggerKeywords: child.metadata.triggerKeywords,
      triggerConditions: child.metadata.triggerConditions,
      sourceLabel: `${sourceLabel} · ${child.path}`,
      trustLevel: "local",
      detailAvailable: true,
    });
    return descriptorId;
  };
  const buildTreeNode = (node, rootNode = false) => {
    const outputs = [];
    if (node.skills.length) {
      const scopePath = node.path || "root";
      const scopeId = `module:${scopePath}`;
      const decision = decideRelation({
        scopeId,
        scopePath,
        scopeKind: "module",
        label: rootNode ? `${metadata.name}能力模块` : `${compositeLabel(node.path.split("/").at(-1))}模块`,
        members: node.skills.map((child) => ({
          ref: `skill:${child.metadata.id}`,
          aliases: [child.metadata.id, child.path],
          name: child.metadata.name,
          description: child.metadata.description,
          body: child.body,
          path: child.path,
          compositeRole: child.compositeRole,
        })),
      });
      const orderedSkills = orderedValues(node.skills, decision, (child) => `skill:${child.metadata.id}`);
      const moduleId = `module:imported:${hashText(`${metadata.id}:${node.path || "root"}`).slice(0, 20)}`;
      const module = {
        id: moduleId,
        nodeType: "module",
        name: rootNode ? `${metadata.name}能力模块` : `${compositeLabel(node.path.split("/").at(-1))}模块`,
        description: rootNode ? metadata.description : `由导入包“${metadata.name}”中的 ${orderedSkills.length} 个子 Skill 组成。`,
        triggerRules: `作为整体插件“${metadata.name}”使用；实际运行能力受所在插槽授权范围限制。`,
        relationType: decision.relationType,
        official: false,
        version: 1,
        slots: orderedSkills.map((child) => ({
          id: `slot:imported:${hashText(`${metadata.id}:${child.path}`).slice(0, 20)}`,
          name: child.metadata.name,
          description: child.metadata.description,
          triggerRules: [...child.metadata.triggerKeywords, ...child.metadata.triggerConditions].join("；"),
          skillId: runtimeSkillId,
          compositeChildId: descriptorFor(child),
          capabilities: child.metadata.capabilities,
          workspaceModes: child.metadata.workspaceModes,
          deliverableTypes: child.metadata.artifactTypes,
          stages: child.metadata.stages,
          official: false,
          allowOfficialFallback: false,
        })),
      };
      modules.push(module);
      relationScopeByNodeId.set(moduleId, scopeId);
      outputs.push({
        targetType: "module",
        targetId: moduleId,
        name: module.name,
        description: module.description,
        path: scopePath,
        ref: `module:${scopePath}`,
        aliases: [`group:${scopePath}`],
      });
    }
    for (const childNode of node.children.values()) outputs.push(buildTreeNode(childNode, false));
    if (outputs.length === 1) return outputs[0];
    const groupId = `group:imported:${hashText(`${metadata.id}:${node.path || "root"}`).slice(0, 20)}`;
    const scopePath = node.path || "root";
    const scopeId = `group:${scopePath}`;
    const decision = decideRelation({
      scopeId,
      scopePath,
      scopeKind: "group",
      label: rootNode ? `${metadata.name}能力模组` : `${compositeLabel(node.path.split("/").at(-1))}模组`,
      members: outputs.map((item) => ({
        ref: item.ref,
        aliases: item.aliases,
        name: item.name,
        description: item.description,
        path: item.path,
      })),
    });
    const orderedOutputs = orderedValues(outputs, decision, (item) => item.ref);
    const group = {
      id: groupId,
      nodeType: "group",
      name: rootNode ? `${metadata.name}能力模组` : `${compositeLabel(node.path.split("/").at(-1))}模组`,
      description: rootNode ? metadata.description : `保留导入包“${metadata.name}”中的原始分层结构。`,
      triggerRules: `作为整体插件“${metadata.name}”使用；不绕过神思任务路由和插槽能力边界。`,
      relationType: decision.relationType,
      official: false,
      version: 1,
      items: orderedOutputs.map((item, index) => ({
        id: `placement:imported:${hashText(`${groupId}:${item.targetId}:${index}`).slice(0, 20)}`,
        targetType: item.targetType,
        targetId: item.targetId,
      })),
    };
    groups.push(group);
    relationScopeByNodeId.set(groupId, scopeId);
    return {
      targetType: "group",
      targetId: groupId,
      name: group.name,
      description: group.description,
      path: scopePath,
      ref: `group:${scopePath}`,
      aliases: [`module:${scopePath}`],
    };
  };
  const root = buildTreeNode(tree, true);
  const settings = compositeManifestSettings(manifest);
  const routingText = `${source}\n${JSON.stringify(settings)}`;
  const hasInternalRouting = settings.taskRouting === true || settings.internalRouting === true
    || /(?:任务路由|能力路由|内部路由|调度|任务分工|协作分工|orchestrat|task\s*router|delegat)/i.test(routingText);
  const rootNode = root.targetType === "group" ? groups.find((group) => group.id === root.targetId) : modules.find((module) => module.id === root.targetId);
  Object.assign(rootNode, {
    libraryAssetId: assetId,
    origin: "imported",
    sourceLabel,
    trustLevel: "local",
    author: metadata.author,
  });
  const bundle = capabilityAssetMiniTemplate({ rootType: root.targetType, rootId: root.targetId, groups, modules });
  const payload = normalizeCapabilityAssetPayload({ rootType: root.targetType, rootId: root.targetId, bundle });
  const decisionByScope = new Map(relationDecisions.map((decision) => [decision.scopeId, decision]));
  const groupById = new Map(payload.bundle.groups.map((group) => [group.id, group]));
  const moduleById = new Map(payload.bundle.modules.map((module) => [module.id, module]));
  const previewNode = (targetType, targetId, seen = new Set()) => {
    if (seen.has(`${targetType}:${targetId}`)) return { nodeType: targetType, id: targetId, name: targetId, children: [] };
    const nextSeen = new Set([...seen, `${targetType}:${targetId}`]);
    const nodeValue = targetType === "group" ? groupById.get(targetId) : moduleById.get(targetId);
    if (!nodeValue) return { nodeType: targetType, id: targetId, name: targetId, children: [] };
    const scopeId = relationScopeByNodeId.get(targetId) || "";
    const decision = decisionByScope.get(scopeId);
    const children = targetType === "group"
      ? nodeValue.items.map((item) => previewNode(item.targetType, item.targetId, nextSeen))
      : nodeValue.slots.map((slot) => ({ nodeType: "skill", id: slot.id, name: slot.name, ref: slot.compositeChildId, children: [] }));
    return {
      nodeType: targetType,
      id: targetId,
      name: nodeValue.name,
      scopeId,
      relationType: nodeValue.relationType,
      confidence: decision?.confidence ?? 1,
      source: decision?.source || "manifest",
      requiresConfirmation: decision?.requiresConfirmation === true,
      children,
    };
  };
  const analysisSummary = compositeRelationAnalysisSummary(relationDecisions);
  const topologyHash = compositeTopologyHash({
    topology: {
      rootType: payload.rootType,
      rootId: payload.rootId,
      groups: payload.bundle.groups.map((group) => ({
        id: group.id,
        relationType: group.relationType,
        items: group.items.map((item) => ({ targetType: item.targetType, targetId: item.targetId })),
      })),
      modules: payload.bundle.modules.map((module) => ({
        id: module.id,
        relationType: module.relationType,
        slots: module.slots.map((slot) => ({ id: slot.id, compositeChildId: slot.compositeChildId })),
      })),
    },
    relationDecisions,
  });
  const capabilities = unique([metadata.capabilities, ...childSkills.map((child) => child.metadata.capabilities)].flat());
  const workspaceModes = unique([metadata.workspaceModes, ...childSkills.map((child) => child.metadata.workspaceModes)].flat());
  const usageGuidance = `默认把“${metadata.name}”作为一个整体插件 Skill 插入插槽；同一整体插件可重复插入不同插槽，每个位置只获得该插槽声明的能力。内部模块与模组用于展示能力结构和边界，不会把子 Skill 分散到“我的 Skill”列表。`;
  const modificationGuidance = hasInternalRouting
    ? "该复合 Skill 含内部任务路由或任务分工。修改子 Skill、模块、模组、关系或职责后，必须同步修改根 Skill 的内部路由与分工规则，否则可能出现漏调用、重复调用或顺序错误。"
    : "该导入包没有检测到内部任务路由；可按普通能力结构修改，不需要额外维护总控分工。";
  return {
    assetId,
    assetType: root.targetType,
    payload,
    includedSkills,
    capabilities,
    workspaceModes,
    hasInternalRouting,
    processorSkillId: COMPOSITE_SKILL_PROCESSOR.id,
    usageGuidance,
    modificationGuidance,
    relationSchemaVersion: COMPOSITE_RELATION_SCHEMA_VERSION,
    relationDecisions,
    packageHash,
    topologyHash,
    inferenceVersion: COMPOSITE_RELATION_INFERENCE_VERSION,
    conflicts: analysisSummary.conflicts,
    requiresConfirmation: analysisSummary.requiresConfirmation,
    minimumConfidence: analysisSummary.minimumConfidence,
    tree: previewNode(root.targetType, root.targetId),
    children: childSkills.map((child, index) => ({
      path: child.path,
      id: child.metadata.id,
      name: child.metadata.name,
      description: child.metadata.description,
      capabilities: child.metadata.capabilities,
      workspaceModes: child.metadata.workspaceModes,
      order: index,
    })),
  };
};

const collectSkillPackageEntries = async (packageRoot, relativeRoot = "") => {
  const entries = [];
  const current = relativeRoot ? join(packageRoot, ...relativeRoot.split("/")) : packageRoot;
  for (const item of await readdir(current, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const relativePath = normalizedPackagePath(relativeRoot ? `${relativeRoot}/${item.name}` : item.name);
    if (!safePackageRelativePath(relativePath)) continue;
    if (item.isDirectory()) {
      entries.push({ name: `${relativePath}/`, content: Buffer.alloc(0) });
      entries.push(...await collectSkillPackageEntries(packageRoot, relativePath));
    } else if (item.isFile()) {
      entries.push({ name: relativePath, content: await readFile(join(current, item.name)) });
    }
  }
  return entries;
};

const bundledMarketplacePackageFiles = async ({ item = {}, shensiRoot = "" } = {}) => {
  const relativeSource = MARKETPLACE_CONTENT_SOURCES[item.id];
  if (!relativeSource || !shensiRoot) return [];
  const sourcePath = resolve(shensiRoot, ...relativeSource.split("/"));
  const allowedRoot = resolve(shensiRoot);
  if (!isInside(sourcePath, allowedRoot)) throw new Error("官方 Skill 包来源越出神思能力包");
  const packageRoot = dirname(sourcePath);
  const entries = await collectSkillPackageEntries(packageRoot);
  return entries
    .filter((file) => !file.name.endsWith("/") && !["skill.md", "manifest.json"].includes(file.name.toLowerCase()))
    .map((file) => ({ path: file.name, content: file.content }));
};

const installMissingSkillPackageFiles = async ({ root, entry, version = "", packageFiles = [] } = {}) => {
  const packageRoot = versionRoot(root, entry.id, version || entry.activeVersion);
  const installed = [];
  for (const file of packageFiles) {
    const relativePath = normalizedPackagePath(file.path);
    if (!safePackageRelativePath(relativePath) || ["skill.md", "manifest.json"].includes(relativePath.toLowerCase())) continue;
    const target = resolve(packageRoot, ...relativePath.split("/"));
    if (!isInside(target, packageRoot)) throw new Error("Skill 包文件路径越界");
    if (await stat(target).catch(() => null)) continue;
    await atomicWrite(target, Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content));
    installed.push(relativePath);
  }
  return installed;
};

const standardSkillManifest = ({ entry, metadata, versionRecord }) => ({
  packageFormat: "shensi-skill-package-v1",
  schemaVersion: metadata.schemaVersion,
  id: metadata.id,
  name: metadata.name,
  version: metadata.version,
  author: metadata.author,
  description: metadata.description,
  trustLevel: normalizedTrustLevel(entry.trustLevel, entry.origin),
  source: {
    type: entry.sourceType || inferredSourceType(entry.source, entry.origin),
    location: entry.source || "local",
    label: entry.sourceLabel || "本地 Skill 库",
  },
  capabilities: metadata.capabilities,
  role: metadata.role,
  workspaceModes: metadata.workspaceModes,
  artifactTypes: metadata.artifactTypes,
  inputRequirements: metadata.inputRequirements,
  outputContract: metadata.outputContract,
  triggerKeywords: metadata.triggerKeywords,
  triggerConditions: metadata.triggerConditions,
  permissions: {
    readCurrentDocument: true,
    readExplicitReferences: true,
    writeCandidateOnly: true,
    taskRouting: false,
    arbitraryFileAccess: false,
    canonWrite: false,
    structuredLanding: false,
  },
  files: {
    instructions: "SKILL.md",
    references: "references/",
    examples: "examples/",
    tests: "tests/",
  },
  ...(entry.compositeDefinition ? {
    composite: {
      schemaVersion: entry.compositeDefinition.relationSchemaVersion || 1,
      processorSkillId: entry.compositeDefinition.processorSkillId,
      taskRouting: entry.compositeDefinition.hasInternalRouting === true,
      childSkills: entry.compositeDefinition.children.map((child) => ({ id: child.id, path: child.path })),
      ...(entry.compositeDefinition.relationDecisions?.length ? {
        relations: compositeManifestRelations(entry.compositeDefinition.relationDecisions),
        packageHash: entry.compositeDefinition.packageHash || "",
        topologyHash: entry.compositeDefinition.topologyHash || "",
        inferenceVersion: entry.compositeDefinition.inferenceVersion || COMPOSITE_RELATION_INFERENCE_VERSION,
      } : {}),
    },
  } : {}),
  hash: versionRecord.hash,
  installedAt: versionRecord.installedAt,
});

const ensureStandardSkillPackage = async (root, entry) => {
  const version = entry.activeVersion;
  const versionRecord = (entry.versions ?? []).find((item) => item.version === version);
  if (!version || !versionRecord) return;
  const packageRoot = versionRoot(root, entry.id, version);
  const manifestFile = join(packageRoot, "manifest.json");
  await Promise.all(["references", "examples", "tests"].map((name) => mkdir(join(packageRoot, name), { recursive: true })));
  if (await stat(manifestFile).catch(() => null)) return;
  const content = await readSkillVersionSource(join(packageRoot, "SKILL.md"));
  const parsed = parseSkillMarkdown(content);
  const metadata = normalizeSkillMetadata(parsed.metadata, { heading: parsed.heading, legacyId: entry.id });
  await atomicWrite(manifestFile, JSON.stringify(standardSkillManifest({ entry, metadata, versionRecord }), null, 2));
};

const loadEntryVersion = async (root, entry, version = entry.activeVersion) => {
  const versionRecord = (entry.versions ?? []).find((item) => item.version === version);
  if (!versionRecord) throw new Error("Skill 版本不存在");
  const path = versionPath(root, entry.id, version);
  const content = await readSkillVersionSource(path);
  const parsed = parseSkillMarkdown(content);
  const metadata = normalizeSkillMetadata(parsed.metadata, { heading: parsed.heading, legacyId: entry.id });
  return { entry, versionRecord, path, content, body: parsed.body, metadata };
};

const normalizeStoredCompositeDefinition = (value) => {
  if (!value || value === false || !Array.isArray(value.children) || !value.children.length) return null;
  const relationDecisions = (Array.isArray(value.relationDecisions) ? value.relationDecisions : []).map((decision) => {
    const relationType = ["parallel", "primary-secondary", "organization"].includes(decision?.relationType)
      ? decision.relationType : "parallel";
    const orderedMembers = unique(decision?.orderedMembers).slice(0, 500);
    return {
      scopeId: String(decision?.scopeId || "").trim().slice(0, 240),
      scopePath: String(decision?.scopePath || "root").trim().slice(0, 240) || "root",
      scopeKind: ["group", "module"].includes(decision?.scopeKind) ? decision.scopeKind : "module",
      label: String(decision?.label || decision?.scopePath || "关系").trim().slice(0, 160),
      relationType,
      orderedMembers,
      members: orderedMembers.map((ref, index) => ({
        ref,
        name: String(decision?.members?.find?.((member) => member?.ref === ref)?.name || ref).trim().slice(0, 160),
        role: relationType === "primary-secondary" ? index === 0 ? "primary" : "secondary"
          : relationType === "organization" ? index === 0 ? "upper" : "lower" : "peer",
      })),
      source: String(decision?.source || "manifest").trim().slice(0, 80),
      confidence: Math.max(0, Math.min(1, Number(decision?.confidence) || 0)),
      evidence: (Array.isArray(decision?.evidence) ? decision.evidence : []).slice(0, 32).map((item) => ({
        kind: String(item?.kind || "evidence").trim().slice(0, 80),
        value: String(item?.value || "").trim().slice(0, 500),
      })),
      conflicts: unique(decision?.conflicts).slice(0, 32).map((message) => message.slice(0, 500)),
      requiresConfirmation: decision?.requiresConfirmation === true,
    };
  }).filter((decision) => decision.scopeId && decision.orderedMembers.length).slice(0, 1_000);
  return {
    assetId: String(value.assetId || "").slice(0, 180),
    processorSkillId: String(value.processorSkillId || COMPOSITE_SKILL_PROCESSOR.id).slice(0, 180),
    hasInternalRouting: value.hasInternalRouting === true,
    capabilities: unique(value.capabilities).filter((capability) => allowedSkillCapabilities("general").includes(capability)).slice(0, 32),
    workspaceModes: unique(value.workspaceModes).filter((mode) => ["project", "notebook", "general"].includes(mode)).slice(0, 3),
    relationSchemaVersion: Number(value.relationSchemaVersion) === COMPOSITE_RELATION_SCHEMA_VERSION ? COMPOSITE_RELATION_SCHEMA_VERSION : 1,
    relationDecisions,
    packageHash: /^[a-f0-9]{64}$/.test(String(value.packageHash || "")) ? String(value.packageHash) : "",
    topologyHash: /^[a-f0-9]{64}$/.test(String(value.topologyHash || "")) ? String(value.topologyHash) : "",
    inferenceVersion: String(value.inferenceVersion || "").trim().slice(0, 40),
    children: value.children.map((child, index) => ({
      path: normalizedPackagePath(child.path),
      id: String(child.id || "").slice(0, 180),
      name: String(child.name || child.id || `子 Skill ${index + 1}`).slice(0, 120),
      description: String(child.description || "").slice(0, 500),
      capabilities: unique(child.capabilities).filter((capability) => allowedSkillCapabilities("general").includes(capability)).slice(0, 32),
      workspaceModes: unique(child.workspaceModes).filter((mode) => ["project", "notebook", "general"].includes(mode)).slice(0, 3),
      order: Number(child.order) || index,
    })).filter((child) => safePackageRelativePath(child.path) && /(?:^|\/)skill\.md$/i.test(child.path)).slice(0, 500),
  };
};

export const installSkillSource = async ({ content, origin = "user", trustLevel = "", sourceType = "", sourceLabel = "", packageFiles, compositeDefinition } = {}) => {
  const source = String(content ?? "").replace(/^\uFEFF/, "");
  if (!source.trim()) throw new Error("Skill 内容为空");
  if (Buffer.byteLength(source, "utf8") > MAX_SKILL_SOURCE_BYTES) throw new Error("单个 Skill 不能超过 256 KB");
  const parsed = parseSkillMarkdown(source);
  const metadata = normalizeSkillMetadata(parsed.metadata, { heading: parsed.heading });
  const validation = validateSkillMetadata(metadata);
  if (!validation.valid) throw new Error(validation.errors.join("；"));
  if (!parsed.body) throw new Error("Skill 正文不能为空");
  const scan = scanSkillSource({ content: source, metadata: { ...metadata, frontmatter: parsed.frontmatter } });
  if (!scan.safe) throw new Error(`Skill 安全扫描未通过：${scan.issues.filter((item) => item.severity === "fatal").map((item) => item.label).join("；")}`);

  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  let entry = registry.skills.find((item) => item.id === metadata.id);
  if (entry?.versions?.some((item) => item.version === metadata.version)) throw new Error("该 Skill 版本已经存在；请提升 version 后再导入");
  const installedAt = Date.now();
  const hash = hashText(source);
  const storedOrigin = normalizedOrigin(origin);
  const storedTrustLevel = installTrustLevel(storedOrigin);
  const storedSourceType = SKILL_SOURCE_TYPES.some((item) => item.id === sourceType)
    ? sourceType : inferredSourceType(metadata.source, storedOrigin);
  const storedCompositeDefinition = compositeDefinition === undefined
    ? normalizeStoredCompositeDefinition(entry?.compositeDefinition)
    : normalizeStoredCompositeDefinition(compositeDefinition);
  let storedPackageFiles = Array.isArray(packageFiles) ? packageFiles : [];
  if (packageFiles === undefined && entry) {
    storedPackageFiles = (await collectSkillPackageEntries(versionRoot(root, entry.id, entry.activeVersion)))
      .filter((file) => !file.name.endsWith("/") && !["skill.md", "manifest.json"].includes(file.name.toLowerCase()))
      .map((file) => ({ path: file.name, content: file.content }));
  }
  const record = {
    version: metadata.version,
    hash,
    installedAt,
    source: storedOrigin,
    trustLevel: storedTrustLevel,
    sourceType: storedSourceType,
    testStatus: "untested",
    testSummary: "尚未测试",
    lastTestedAt: 0,
    compositeDefinition: storedCompositeDefinition ? structuredClone(storedCompositeDefinition) : null,
  };
  const packageRoot = versionRoot(root, metadata.id, metadata.version);
  try {
    await atomicWrite(versionPath(root, metadata.id, metadata.version), source);
    for (const file of storedPackageFiles) {
      if (!safePackageRelativePath(file.path) || ["skill.md", "manifest.json"].includes(String(file.path).toLowerCase())) throw new Error(`Skill 包含不安全的文件路径：${file.path}`);
      const target = resolve(packageRoot, ...normalizedPackagePath(file.path).split("/"));
      if (!isInside(target, packageRoot)) throw new Error("Skill 包文件路径越界");
      await atomicWrite(target, Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content));
    }
  } catch (error) {
    await rm(packageRoot, { recursive: true, force: true });
    throw error;
  }
  skillVersionReadCache.delete(versionPath(root, metadata.id, metadata.version));
  if (!entry) {
    entry = { id: metadata.id, versions: [] };
    registry.skills.push(entry);
  }
  Object.assign(entry, {
    id: metadata.id,
    name: metadata.name,
    activeVersion: metadata.version,
    author: metadata.author,
    description: metadata.description,
    prototypeId: metadata.prototypeId,
    prototypeName: metadata.prototypeName,
    prototypeFingerprint: metadata.prototypeFingerprint,
    derivativeCopy: metadata.derivativeCopy === true,
    upstreamId: metadata.upstreamId || entry.upstreamId || "",
    upstreamVersion: metadata.upstreamVersion || entry.upstreamVersion || "",
    changeSummary: metadata.changeSummary,
    capabilityBoundary: metadata.capabilityBoundary,
    origin: storedOrigin,
    source: metadata.source,
    trustLevel: storedTrustLevel,
    sourceType: storedSourceType,
    sourceLabel: String(sourceLabel || entry.sourceLabel || metadata.source || "本地 Skill 库").trim().slice(0, 160),
    capabilities: metadata.capabilities,
    declaredCapabilities: metadata.declaredCapabilities,
    role: metadata.role,
    workspaceModes: metadata.workspaceModes,
    artifactTypes: metadata.artifactTypes,
    inputRequirements: metadata.inputRequirements,
    outputContract: metadata.outputContract,
    stages: metadata.stages,
    slots: metadata.slots,
    conflictPolicy: metadata.conflictPolicy,
    fallback: metadata.fallback,
    triggerKeywords: metadata.triggerKeywords,
    triggerConditions: metadata.triggerConditions,
    compositeDefinition: storedCompositeDefinition,
    hash,
    installedAt: entry.installedAt || installedAt,
    lastTestedAt: 0,
    testStatus: "untested",
    testSummary: "新版本尚未测试",
    sandboxVerified: false,
    sandboxVerifiedVersion: "",
    versions: [...(entry.versions ?? []), record],
  });
  await ensureStandardSkillPackage(root, entry);
  await writeRegistry(root, registry);
  return { skill: publicSkill(entry), scan };
};

const applyImportedCompositeAssetToRegistry = ({ registry, compiled, metadata, sourceLabel, sourceType = "local_folder", origin = "imported" } = {}) => {
  const assetOrigin = normalizedOrigin(origin) === "downloaded" ? "downloaded" : "imported";
  const trustLevel = assetOrigin === "downloaded" ? "community" : "local";
  const existing = (registry.capabilityAssets ?? []).find((asset) => asset.id === compiled.assetId);
  const installedAt = Date.now();
  const localNodeIds = [...compiled.payload.bundle.groups.map((group) => group.id), ...compiled.payload.bundle.modules.map((module) => module.id)];
  const previousNodeIds = new Set(existing?.localNodeIds ?? []);
  const nextTemplate = normalizeCapabilityTemplate(registry.capabilityTemplate.current);
  if (existing) {
    const oldRootId = existing.localRootId;
    const replacementRootId = compiled.payload.rootId;
    const rewritePlacement = (placement) => placement.targetId === oldRootId ? { ...placement, targetId: replacementRootId } : placement;
    nextTemplate.template.items = nextTemplate.template.items.map(rewritePlacement);
    for (const group of nextTemplate.groups) group.items = group.items.map(rewritePlacement);
    nextTemplate.groups = nextTemplate.groups.filter((group) => !previousNodeIds.has(group.id));
    nextTemplate.modules = nextTemplate.modules.filter((module) => !previousNodeIds.has(module.id));
  }
  nextTemplate.groups.push(...compiled.payload.bundle.groups.map((group) => structuredClone(group)));
  nextTemplate.modules.push(...compiled.payload.bundle.modules.map((module) => structuredClone(module)));
  const validation = validateCapabilityTemplate(nextTemplate);
  if (!validation.valid) throw new Error(`复合 Skill 结构转换失败：${validation.errors.join("；")}`);
  registry.capabilityTemplate.current = validation.bundle;
  registry.capabilityTemplate = normalizeCapabilityTemplateState(registry.capabilityTemplate, {
    customSlots: registry.customSlots,
    customSlotGroups: registry.customSlotGroups,
  });
  bumpRouteRevision(registry, { reason: "skill_changed", sourceScopeType: "skill", sourceScopeId: compiled.payload.rootId });
  if (existing) {
    const nextVersion = (existing.versions ?? []).reduce((maximum, version) => Math.max(maximum, Number(version.version) || 0), 0) + 1;
    const record = capabilityAssetVersion({
      version: nextVersion,
      payload: compiled.payload,
      includedSkills: compiled.includedSkills,
      source: assetOrigin,
      trustLevel,
      installedAt,
    });
    Object.assign(existing, {
      assetType: compiled.assetType,
      sourceId: metadata.id,
      localRootId: compiled.payload.rootId,
      localNodeIds,
      name: metadata.name,
      author: metadata.author,
      description: metadata.description,
      origin: assetOrigin,
      sourceType,
      trustLevel,
      sourceLabel,
      integrationSkillId: `user:${metadata.id}`,
      compositeRouting: compiled.hasInternalRouting,
      processorSkillId: compiled.processorSkillId,
      usageGuidance: compiled.usageGuidance,
      modificationGuidance: compiled.modificationGuidance,
      activeVersion: record.version,
      versions: [...(existing.versions ?? []), record].slice(-CAPABILITY_ASSET_HISTORY_LIMIT),
      testStatus: "untested",
      testSummary: "复合结构已更新；整体插件 Skill 尚未测试",
      updatedAt: installedAt,
    });
    return existing;
  }
  const asset = normalizeStoredCapabilityAsset({
    id: compiled.assetId,
    assetType: compiled.assetType,
    sourceId: metadata.id,
    localRootId: compiled.payload.rootId,
    localNodeIds,
    name: metadata.name,
    author: metadata.author,
    description: metadata.description,
    origin: assetOrigin,
    sourceType,
    trustLevel,
    sourceLabel,
    integrationSkillId: `user:${metadata.id}`,
    compositeRouting: compiled.hasInternalRouting,
    processorSkillId: compiled.processorSkillId,
    usageGuidance: compiled.usageGuidance,
    modificationGuidance: compiled.modificationGuidance,
    activeVersion: 1,
    versions: [capabilityAssetVersion({ version: 1, payload: compiled.payload, includedSkills: compiled.includedSkills, source: assetOrigin, trustLevel, installedAt })],
    testStatus: "untested",
    testSummary: "复合结构已转换；整体插件 Skill 尚未测试",
    installedAt,
    updatedAt: installedAt,
  });
  registry.capabilityAssets = [...(registry.capabilityAssets ?? []), asset];
  return asset;
};

const validateCompositeRootSource = (source) => {
  const parsed = parseSkillMarkdown(String(source || "").replace(/^\uFEFF/, ""));
  const metadata = normalizeSkillMetadata(parsed.metadata, { heading: parsed.heading });
  const validation = validateSkillMetadata(metadata);
  if (!validation.valid) throw new Error(validation.errors.join("；"));
  if (!parsed.body) throw new Error("Skill 正文不能为空");
  const scan = scanSkillSource({ content: source, metadata: { ...metadata, frontmatter: parsed.frontmatter } });
  if (!scan.safe) throw new Error(`Skill 安全扫描未通过：${scan.issues.filter((item) => item.severity === "fatal").map((item) => item.label).join("；")}`);
  return { metadata, scan };
};

const applyCompositeRootSkillToRegistry = ({ registry, parsed, compiled, origin, sourceType, sourceLabel, installedAt }) => {
  const source = String(parsed.source || "").replace(/^\uFEFF/, "");
  const { metadata, scan } = validateCompositeRootSource(source);
  let entry = registry.skills.find((item) => item.id === metadata.id);
  if (entry?.versions?.some((item) => item.version === metadata.version)) throw new Error("该 Skill 版本已经存在；请提升 version 后再导入");
  const hash = hashText(source);
  const storedOrigin = normalizedOrigin(origin);
  const storedTrustLevel = installTrustLevel(storedOrigin);
  const storedSourceType = SKILL_SOURCE_TYPES.some((item) => item.id === sourceType)
    ? sourceType : inferredSourceType(metadata.source, storedOrigin);
  const storedCompositeDefinition = normalizeStoredCompositeDefinition(compiled);
  const record = {
    version: metadata.version,
    hash,
    installedAt,
    source: storedOrigin,
    trustLevel: storedTrustLevel,
    sourceType: storedSourceType,
    testStatus: "untested",
    testSummary: "尚未测试",
    lastTestedAt: 0,
    compositeDefinition: structuredClone(storedCompositeDefinition),
  };
  if (!entry) {
    entry = { id: metadata.id, versions: [] };
    registry.skills.push(entry);
  }
  Object.assign(entry, {
    id: metadata.id,
    name: metadata.name,
    activeVersion: metadata.version,
    author: metadata.author,
    description: metadata.description,
    prototypeId: metadata.prototypeId,
    prototypeName: metadata.prototypeName,
    prototypeFingerprint: metadata.prototypeFingerprint,
    derivativeCopy: metadata.derivativeCopy === true,
    upstreamId: metadata.upstreamId || entry.upstreamId || "",
    upstreamVersion: metadata.upstreamVersion || entry.upstreamVersion || "",
    changeSummary: metadata.changeSummary,
    capabilityBoundary: metadata.capabilityBoundary,
    origin: storedOrigin,
    source: metadata.source,
    trustLevel: storedTrustLevel,
    sourceType: storedSourceType,
    sourceLabel: String(sourceLabel || entry.sourceLabel || metadata.source || "本地 Skill 库").trim().slice(0, 160),
    capabilities: metadata.capabilities,
    declaredCapabilities: metadata.declaredCapabilities,
    role: metadata.role,
    workspaceModes: metadata.workspaceModes,
    artifactTypes: metadata.artifactTypes,
    inputRequirements: metadata.inputRequirements,
    outputContract: metadata.outputContract,
    stages: metadata.stages,
    slots: metadata.slots,
    conflictPolicy: metadata.conflictPolicy,
    fallback: metadata.fallback,
    triggerKeywords: metadata.triggerKeywords,
    triggerConditions: metadata.triggerConditions,
    compositeDefinition: storedCompositeDefinition,
    hash,
    installedAt: entry.installedAt || installedAt,
    lastTestedAt: 0,
    testStatus: "untested",
    testSummary: "新版本尚未测试",
    sandboxVerified: false,
    sandboxVerifiedVersion: "",
    versions: [...(entry.versions ?? []), record],
  });
  return { entry, record, metadata, scan };
};

const stageCompositeSkillPackage = async ({ root, entry, record, parsed }) => {
  const transactionRoot = resolve(root, ".transactions", `composite-${process.pid}-${randomUUID()}`);
  const stagedPackageRoot = join(transactionRoot, "package");
  const finalPackageRoot = versionRoot(root, entry.id, record.version);
  if (await stat(finalPackageRoot).catch(() => null)) throw new Error("该 Skill 版本目录已经存在，已停止导入");
  try {
    await atomicWrite(join(stagedPackageRoot, "SKILL.md"), parsed.source);
    for (const file of parsed.packageFiles) {
      if (String(file.path || "").endsWith("/")) continue;
      if (!safePackageRelativePath(file.path) || ["skill.md", "manifest.json"].includes(String(file.path).toLowerCase())) {
        throw new Error(`Skill 包含不安全的文件路径：${file.path}`);
      }
      const target = resolve(stagedPackageRoot, ...normalizedPackagePath(file.path).split("/"));
      if (!isInside(target, stagedPackageRoot)) throw new Error("Skill 包文件路径越界");
      await atomicWrite(target, Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content));
    }
    await Promise.all(["references", "examples", "tests"].map((name) => mkdir(join(stagedPackageRoot, name), { recursive: true })));
    const parsedSource = parseSkillMarkdown(parsed.source);
    const metadata = normalizeSkillMetadata(parsedSource.metadata, { heading: parsedSource.heading, legacyId: entry.id });
    await atomicWrite(join(stagedPackageRoot, "manifest.json"), JSON.stringify(standardSkillManifest({ entry, metadata, versionRecord: record }), null, 2));
    await mkdir(dirname(finalPackageRoot), { recursive: true });
    await renameWithTransientRetry(stagedPackageRoot, finalPackageRoot);
    return { transactionRoot, finalPackageRoot };
  } catch (error) {
    await rm(transactionRoot, { recursive: true, force: true });
    throw error;
  }
};

export const analyzeSkillPackage = async ({ bytes, sourceLabel = "本地 Skill 包" } = {}) => {
  const packageBytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const packageHash = hashBytes(packageBytes);
  const parsed = parseSkillPackage(packageBytes);
  validateCompositeRootSource(parsed.source);
  const compiled = compileCompositeSkillPackage({ ...parsed, sourceLabel, packageHash });
  return {
    packageHash,
    composite: Boolean(compiled),
    skill: {
      id: parsed.metadata.id,
      name: parsed.metadata.name,
      version: parsed.metadata.version,
      author: parsed.metadata.author,
      description: parsed.metadata.description,
      childCount: parsed.childSkills.length,
    },
    tree: compiled?.tree ?? null,
    relations: compiled?.relationDecisions ?? [],
    conflicts: compiled?.conflicts ?? [],
    requiresConfirmation: Boolean(compiled),
    hasAmbiguity: compiled?.requiresConfirmation === true,
    minimumConfidence: compiled?.minimumConfidence ?? 1,
    topologyHash: compiled?.topologyHash ?? "",
    inferenceVersion: COMPOSITE_RELATION_INFERENCE_VERSION,
  };
};

export const installSkillPackage = async ({
  bytes,
  origin = "imported",
  sourceType = "local_folder",
  sourceLabel = "本地 Skill 包",
  expectedPackageHash = "",
  confirmedRelations = [],
  confirmed = false,
} = {}) => {
  const packageBytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const packageHash = hashBytes(packageBytes);
  if (expectedPackageHash && expectedPackageHash !== packageHash) throw new Error("Skill 包已变化，请重新分析后再导入");
  const parsed = parseSkillPackage(packageBytes);
  const initialCompiled = compileCompositeSkillPackage({ ...parsed, sourceLabel, packageHash });
  if (!initialCompiled) {
    const installed = await installSkillSource({
      content: parsed.source,
      packageFiles: parsed.packageFiles,
      origin,
      sourceType,
      sourceLabel,
      compositeDefinition: false,
    });
    return { ...installed, composite: false, packageHash, processor: COMPOSITE_SKILL_PROCESSOR };
  }
  const localImport = normalizedOrigin(origin) === "imported";
  const reviewedGithubDownload = sourceType === "github";
  const requiresReview = localImport || reviewedGithubDownload;
  if (requiresReview && !/^[a-f0-9]{64}$/i.test(String(expectedPackageHash || ""))) {
    const error = new Error("复合 Skill 必须携带分析阶段返回的包哈希，不能绕过预览直接安装");
    error.code = "COMPOSITE_PACKAGE_HASH_REQUIRED";
    error.statusCode = 409;
    throw error;
  }
  if (requiresReview && confirmed !== true) {
    const error = new Error("复合 Skill 必须先预览并确认关系后才能导入");
    error.code = "COMPOSITE_REVIEW_REQUIRED";
    error.statusCode = 409;
    throw error;
  }
  if (requiresReview) {
    const expectedScopes = new Set(initialCompiled.relationDecisions.map((decision) => decision.scopeId));
    const submittedScopes = new Set((Array.isArray(confirmedRelations) ? confirmedRelations : []).map((decision) => String(decision?.scopeId || "")));
    if (expectedScopes.size !== submittedScopes.size || [...expectedScopes].some((scopeId) => !submittedScopes.has(scopeId))) {
      throw new Error("必须确认复合 Skill 的每一层关系，不能跳过未确认层级");
    }
  }
  if (!requiresReview && initialCompiled.requiresConfirmation) {
    throw new Error("下载的复合 Skill 缺少可直接采用的明确关系声明");
  }
  const compiled = requiresReview
    ? compileCompositeSkillPackage({ ...parsed, sourceLabel, packageHash, confirmedRelations })
    : initialCompiled;
  const root = await ensureSkillStore();
  const previousRegistry = structuredClone(await readRegistry(root));
  const registry = structuredClone(previousRegistry);
  const installedAt = Date.now();
  const prepared = applyCompositeRootSkillToRegistry({ registry, parsed, compiled, origin, sourceType, sourceLabel, installedAt });
  const storedAsset = applyImportedCompositeAssetToRegistry({ registry, compiled, metadata: prepared.metadata, sourceLabel, sourceType, origin });
  const staged = await stageCompositeSkillPackage({ root, entry: prepared.entry, record: prepared.record, parsed });
  try {
    if (process.env.SHENSI_TEST_COMPOSITE_FAIL_AFTER_STAGE === "1") throw new Error("测试注入：复合 Skill 暂存后失败");
    await writeRegistry(root, registry);
  } catch (error) {
    await rm(staged.finalPackageRoot, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(staged.transactionRoot, { recursive: true, force: true });
  }
  skillVersionReadCache.delete(versionPath(root, prepared.entry.id, prepared.record.version));
  return {
    skill: publicSkill(prepared.entry),
    scan: prepared.scan,
    asset: publicCapabilityAsset(storedAsset, registry),
    composite: true,
    packageHash,
    topologyHash: compiled.topologyHash,
    processor: COMPOSITE_SKILL_PROCESSOR,
  };
};

const findManagedEntry = async (requestedId) => {
  const id = String(requestedId ?? "").replace(/^user:/, "");
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const entry = registry.skills.find((item) => item.id === id);
  if (!entry) throw new Error("Skill 不存在");
  return { root, registry, entry };
};

const loadCompositeSkillChildren = async (root, entry, versionRecord) => {
  const definition = normalizeStoredCompositeDefinition(versionRecord?.compositeDefinition || entry.compositeDefinition);
  if (!definition) return [];
  const packageRoot = versionRoot(root, entry.id, versionRecord.version);
  const loaded = [];
  for (const child of [...definition.children].sort((left, right) => left.order - right.order)) {
    const target = resolve(packageRoot, ...child.path.split("/"));
    if (!isInside(target, packageRoot)) continue;
    const source = await readFile(target, "utf8").catch(() => "");
    if (!source) continue;
    const parsed = parseSkillMarkdown(source);
    loaded.push({ ...child, body: parsed.body || source });
  }
  return loaded;
};

const compositeSkillRuntimeBody = (skill = {}, selection = {}) => {
  const children = Array.isArray(skill.compositeChildren) ? skill.compositeChildren : [];
  if (!children.length) return skill.body || "";
  const authorized = unique(selection?.authorizedCapabilities);
  const matching = authorized.length
    ? children.filter((child) => child.capabilities.some((capability) => authorized.includes(capability)))
    : children;
  if (!matching.length) return `${skill.body || ""}\n\n# 复合 Skill 插槽约束\n当前插槽没有授权任何子 Skill 能力，因此本轮只保留总控规则，不加载子 Skill 指令。`;
  return [
    skill.body || "",
    "# 本轮获准加载的内部子 Skill",
    "以下子 Skill 仍受当前插槽能力边界约束；未列出的内部能力本轮不得启用。",
    ...matching.map((child, index) => `## 子 Skill ${index + 1}：${child.name}\n${child.body}`),
  ].filter(Boolean).join("\n\n");
};

export const loadManagedSkill = async ({ id, version = "", includeContent = false } = {}) => {
  const { root, entry } = await findManagedEntry(id);
  const loaded = await loadEntryVersion(root, entry, version || entry.activeVersion);
  const compositeChildren = includeContent ? await loadCompositeSkillChildren(root, entry, loaded.versionRecord) : [];
  return {
    ...publicSkill(entry),
    ...(includeContent ? { content: loaded.content, body: loaded.body, compositeChildren, sourcePath: loaded.path } : {}),
  };
};

export const testManagedSkill = async ({ id, sandboxTest = null } = {}) => {
  const { root, registry, entry } = await findManagedEntry(id);
  const loaded = await loadEntryVersion(root, entry);
  const mainScan = scanSkillSource({ content: loaded.content, metadata: { ...loaded.metadata, frontmatter: parseSkillMarkdown(loaded.content).frontmatter } });
  const requiredRules = await loadWritingSkillRuleSources({ sourcePath: loaded.path, content: loaded.content });
  const ruleScan = scanSkillSource({ content: requiredRules.files.map((file) => file.content).join("\n\n") });
  const scan = {
    safe: mainScan.safe && ruleScan.safe,
    issues: [...mainScan.issues, ...ruleScan.issues],
    blockedCapabilities: unique([...mainScan.blockedCapabilities, ...ruleScan.blockedCapabilities]),
  };
  const official = entry.trustLevel === "official";
  const baseTest = skillTestSummary({ skill: loaded.metadata, body: loaded.body, scan, sandboxTest: official ? null : sandboxTest });
  const requiredFilesCheck = {
    id: "required_files",
    pass: requiredRules.failures.length === 0,
    label: requiredRules.failures.length
      ? `必读规则文件不可用：${requiredRules.failures.map((failure) => failure.path).join("、")}`
      : "必读规则文件均可完整读取",
  };
  const test = {
    ...baseTest,
    passed: baseTest.passed && requiredFilesCheck.pass,
    checks: [...baseTest.checks, requiredFilesCheck],
    summary: baseTest.passed && requiredFilesCheck.pass
      ? baseTest.summary
      : [...baseTest.checks.filter((check) => !check.pass).map((check) => check.label), ...(requiredFilesCheck.pass ? [] : [requiredFilesCheck.label])].join("；"),
  };
  entry.lastTestedAt = Date.now();
  entry.testStatus = test.passed ? "passed" : "failed";
  entry.testSummary = official && test.passed ? "官方 Skill 已通过内置静态合同与安全校验。" : test.summary;
  entry.sandboxVerified = test.passed && test.checks.some((check) => check.id === "sandbox" && check.pass === true);
  entry.sandboxVerifiedVersion = entry.sandboxVerified ? entry.activeVersion : "";
  const activeVersion = (entry.versions ?? []).find((version) => version.version === entry.activeVersion);
  if (activeVersion) Object.assign(activeVersion, {
    testStatus: entry.testStatus,
    testSummary: entry.testSummary,
    lastTestedAt: entry.lastTestedAt,
    sandboxVerified: entry.sandboxVerified,
  });
  await writeRegistry(root, registry);
  return { skill: publicSkill(entry), scan, test };
};

const installableMarketplaceSkillSource = ({ item = {}, content = "" } = {}) => {
  const parsed = parseSkillMarkdown(content);
  const metadata = normalizeSkillMetadata(parsed.metadata, { heading: parsed.heading });
  const managedId = marketplaceManagedSkillId(item);
  if (validateSkillMetadata(metadata).valid && metadata.id === managedId) return content;
  const capabilities = (item.capabilities ?? []).filter((capability) => allowedSkillCapabilities("general").includes(capability));
  return `---
schema_version: 2
id: ${yamlString(managedId)}
name: ${yamlString(item.name || metadata.name || "官方 Skill")}
version: ${yamlString(item.version || "1.0.0")}
author: ${yamlString(item.author || "神思团队")}
description: ${yamlString(item.description || metadata.description || "神思官方 Skill")}
source: "official-marketplace"
workspace_modes:${yamlList(item.workspaceModes?.length ? item.workspaceModes : ["general"])}
capabilities:${yamlList(capabilities.length ? capabilities : ["auxiliary_advisor"])}
capability_boundary: ${yamlString(item.capabilityBoundary || `只在“${item.name || "官方 Skill"}”声明的辅助能力范围内生效，不接管可信内核。`)}
---

${parsed.body || content || `# ${item.name || "官方 Skill"}`}
`;
};

const capabilityAssetActiveRecord = (entry = {}) => (entry.versions ?? []).find((version) => version.version === entry.activeVersion) || entry.versions?.at(-1);
const capabilityLibraryId = (assetType, marketplaceId) => `library:${assetType}:${hashText(`${marketplaceId}:${randomUUID()}`).slice(0, 20)}`;
const suffixedCapabilityId = (id, suffix, prefix) => {
  const stem = String(id || prefix).slice(0, 125).replace(/:+$/g, "");
  return `${stem}:lib:${suffix}`;
};

const remapCapabilityAssetPayloadForInstall = (inputPayload, { assetId, item } = {}) => {
  const payload = normalizeCapabilityAssetPayload(inputPayload);
  if (payload.rootType === "template") {
    const bundle = structuredClone(payload.bundle);
    Object.assign(bundle.template, {
      libraryAssetId: assetId,
      marketplaceId: item.id,
      origin: "downloaded",
      sourceLabel: item.sourceLabel || "Skill 广场",
      trustLevel: item.trustLevel || "community",
      author: item.author || "未声明",
    });
    return { payload: normalizeCapabilityAssetPayload({ ...payload, bundle }), localNodeIds: [bundle.template.id] };
  }
  const suffix = hashText(assetId).slice(0, 10);
  const bundle = structuredClone(payload.bundle);
  const groupIds = new Map(bundle.groups.map((group) => [group.id, suffixedCapabilityId(group.id, suffix, "group:downloaded")]));
  const moduleIds = new Map(bundle.modules.map((module) => [module.id, suffixedCapabilityId(module.id, suffix, "module:downloaded")]));
  bundle.groups = bundle.groups.map((group) => ({
    ...group,
    id: groupIds.get(group.id),
    items: group.items.map((placement, index) => ({
      ...placement,
      id: suffixedCapabilityId(placement.id || `placement:${index + 1}`, suffix, "placement:downloaded"),
      targetId: placement.targetType === "group" ? groupIds.get(placement.targetId) : moduleIds.get(placement.targetId),
    })),
  }));
  bundle.modules = bundle.modules.map((module) => ({
    ...module,
    id: moduleIds.get(module.id),
    slots: module.slots.map((slot, index) => ({
      ...slot,
      id: suffixedCapabilityId(slot.id || `slot:${index + 1}`, suffix, "slot:downloaded"),
    })),
  }));
  bundle.template.items = bundle.template.items.map((placement, index) => ({
    ...placement,
    id: suffixedCapabilityId(placement.id || `placement:${index + 1}`, suffix, "placement:downloaded-root"),
    targetId: placement.targetType === "group" ? groupIds.get(placement.targetId) : moduleIds.get(placement.targetId),
  }));
  const rootId = payload.rootType === "group" ? groupIds.get(payload.rootId) : moduleIds.get(payload.rootId);
  const rootNode = capabilityTemplateNode(bundle, payload.rootType, rootId);
  Object.assign(rootNode, {
    libraryAssetId: assetId,
    marketplaceId: item.id,
    origin: "downloaded",
    sourceLabel: item.sourceLabel || "Skill 广场",
    trustLevel: item.trustLevel || "community",
    author: item.author || "未声明",
  });
  const localNodeIds = [...bundle.groups.map((group) => group.id), ...bundle.modules.map((module) => module.id)];
  return {
    payload: normalizeCapabilityAssetPayload({ rootType: payload.rootType, rootId, bundle }),
    localNodeIds,
  };
};

const capabilityAssetTestResult = (registry, inputPayload) => {
  const payload = normalizeCapabilityAssetPayload(inputPayload);
  const missingSkills = [];
  const untestedSkills = [];
  for (const module of payload.bundle.modules) {
    for (const slot of module.slots) {
      const skillId = String(slot.skillId || "");
      if (!skillId || skillId.startsWith("builtin:")) continue;
      const managedId = skillId.replace(/^user:/, "");
      const skill = registry.skills.find((entry) => entry.id === managedId);
      if (!skill) missingSkills.push(slot.name || skillId);
      else if (skill.testStatus !== "passed") untestedSkills.push(skill.name || skillId);
    }
  }
  const nodeCount = payload.bundle.groups.length + payload.bundle.modules.length;
  const slotCount = payload.bundle.modules.reduce((total, module) => total + module.slots.length, 0);
  const notices = [
    missingSkills.length ? `${missingSkills.length} 个插槽引用尚未安装的 Skill` : "",
    untestedSkills.length ? `${untestedSkills.length} 个 Skill 尚未测试通过` : "",
  ].filter(Boolean);
  return {
    passed: true,
    summary: `结构、依赖闭包和循环检查通过；${nodeCount} 个节点、${slotCount} 个插槽${notices.length ? `；${notices.join("；")}` : "。"}`,
    nodeCount,
    slotCount,
    missingSkills,
    untestedSkills,
  };
};

const appendCapabilityAssetVersion = (entry, payload, { source = "edited", marketplaceId = entry.marketplaceId } = {}) => {
  const normalizedPayload = normalizeCapabilityAssetPayload(payload, entry.assetType);
  const nextVersion = (entry.versions ?? []).reduce((maximum, version) => Math.max(maximum, Number(version.version) || 0), 0) + 1;
  const previousIncludedSkills = capabilityAssetActiveRecord(entry)?.includedSkills ?? [];
  const record = capabilityAssetVersion({
    version: nextVersion,
    payload: normalizedPayload,
    includedSkills: previousIncludedSkills,
    source,
    trustLevel: entry.trustLevel,
    marketplaceId,
  });
  entry.versions = [...(entry.versions ?? []), record].slice(-CAPABILITY_ASSET_HISTORY_LIMIT);
  entry.activeVersion = record.version;
  entry.updatedAt = record.installedAt;
  entry.testStatus = "untested";
  entry.testSummary = "新版本尚未测试";
  return record;
};

const syncCapabilityAssetsFromCurrent = (registry, { scopeType, scopeId } = {}) => {
  const bundle = registry.capabilityTemplate.current;
  const changed = [];
  for (const asset of registry.capabilityAssets ?? []) {
    const affected = asset.assetType === "template"
      ? registry.activeCapabilityTemplateAssetId === asset.id
      : asset.localNodeIds.includes(scopeId) || (scopeType === "template" && asset.localRootId && capabilityTemplateNode(bundle, asset.assetType, asset.localRootId));
    if (!affected) continue;
    try {
      const payload = capabilityAssetPayloadFromBundle(bundle, asset.assetType, asset.localRootId || bundle.template.id);
      appendCapabilityAssetVersion(asset, payload);
      const node = capabilityTemplateNode(bundle, asset.assetType, asset.localRootId || bundle.template.id);
      asset.name = node?.name || asset.name;
      asset.description = node?.description || asset.description;
      if (node?.prototypeId && node.official !== true) {
        asset.trustLevel = "verified";
        asset.sourceLabel = `官方衍生：${node.prototypeName || asset.sourceLabel}`;
      }
      changed.push(asset.id);
    } catch {}
  }
  return changed;
};

const installMarketplaceCapabilityAsset = async ({ item, root, registry, replaceLocalVersions = false } = {}) => {
  const assetType = marketplaceAssetType(item);
  const existing = (registry.capabilityAssets ?? []).find((asset) => asset.marketplaceId === item.id || (item.sourceId && asset.sourceId === item.sourceId));
  if (!replaceLocalVersions && existing && (existing.versions ?? []).some((version) => version.marketplaceId === item.id || (item.hash && version.hash === item.hash))) {
    return { asset: publicCapabilityAsset(existing, registry), alreadyInstalled: true, updated: false };
  }
  const assetId = existing?.id || capabilityLibraryId(assetType, item.id);
  const includedSkills = capabilityIncludedSkills(item.payload, registry, item.includedSkills);
  const remapped = remapCapabilityAssetPayloadForInstall(item.payload, { assetId, item });
  const installedAt = Date.now();
  if (existing) {
    const previousRecord = capabilityAssetActiveRecord(existing);
    const nextVersion = replaceLocalVersions
      ? 1
      : (existing.versions ?? []).reduce((maximum, version) => Math.max(maximum, Number(version.version) || 0), 0) + 1;
    const record = capabilityAssetVersion({
      version: nextVersion,
      payload: remapped.payload,
      includedSkills,
      source: "downloaded",
      trustLevel: item.trustLevel,
      installedAt,
      marketplaceId: item.id,
    });
    existing.versions = replaceLocalVersions
      ? [record]
      : [...(existing.versions ?? []), record].slice(-CAPABILITY_ASSET_HISTORY_LIMIT);
    existing.activeVersion = record.version;
    existing.marketplaceId = item.id;
    existing.sourceId = item.sourceId || existing.sourceId;
    existing.localRootId = remapped.payload.rootId;
    existing.localNodeIds = remapped.localNodeIds;
    existing.name = item.name;
    existing.author = item.author;
    existing.description = item.description;
    existing.trustLevel = item.trustLevel;
    existing.sourceLabel = item.sourceLabel;
    existing.updatedAt = installedAt;
    existing.testStatus = "untested";
    existing.testSummary = "下载的新版本尚未测试";

    if (assetType === "template" && registry.activeCapabilityTemplateAssetId === existing.id) {
      const next = structuredClone(remapped.payload.bundle);
      Object.assign(next.template, {
        libraryAssetId: existing.id,
        marketplaceId: item.id,
        origin: "downloaded",
        sourceLabel: item.sourceLabel,
        trustLevel: item.trustLevel,
        author: item.author,
      });
      registry.capabilityTemplate.current = normalizeCapabilityTemplate(next);
      registry.capabilityTemplate = normalizeCapabilityTemplateState(registry.capabilityTemplate, {
        customSlots: registry.customSlots,
        customSlotGroups: registry.customSlotGroups,
      });
      bumpRouteRevision(registry, { reason: "activated", sourceScopeType: "template", sourceScopeId: registry.capabilityTemplate.current.template.id });
    } else if (assetType !== "template") {
      const oldNodeIds = new Set(previousRecord?.payload
        ? [...previousRecord.payload.bundle.groups.map((node) => node.id), ...previousRecord.payload.bundle.modules.map((node) => node.id)]
        : existing.localNodeIds);
      const next = normalizeCapabilityTemplate(registry.capabilityTemplate.current);
      const oldRootId = previousRecord?.payload?.rootId || existing.localRootId;
      const newRootId = remapped.payload.rootId;
      const rewritePlacement = (placement) => placement.targetId === oldRootId ? { ...placement, targetId: newRootId } : placement;
      next.template.items = next.template.items.map(rewritePlacement);
      for (const group of next.groups) group.items = group.items.map(rewritePlacement);
      next.groups = next.groups.filter((group) => !oldNodeIds.has(group.id));
      next.modules = next.modules.filter((module) => !oldNodeIds.has(module.id));
      next.groups.push(...remapped.payload.bundle.groups.map((node) => structuredClone(node)));
      next.modules.push(...remapped.payload.bundle.modules.map((node) => structuredClone(node)));
      const validation = validateCapabilityTemplate(applyCapabilityKernelMechanisms(next));
      if (!validation.valid) throw new Error(`能力资产更新失败：${validation.errors.join("；")}`);
      registry.capabilityTemplate.current = validation.bundle;
      registry.capabilityTemplate = normalizeCapabilityTemplateState(registry.capabilityTemplate, {
        customSlots: registry.customSlots,
        customSlotGroups: registry.customSlotGroups,
      });
      bumpRouteRevision(registry, { reason: "route_changed", sourceScopeType: assetType, sourceScopeId: remapped.payload.rootId });
    }
    await writeRegistry(root, registry);
    return { asset: publicCapabilityAsset(existing, registry), alreadyInstalled: false, updated: true, replacedLocalHistory: replaceLocalVersions, routeRevision: registry.routeRevision };
  }
  const asset = normalizeStoredCapabilityAsset({
    id: assetId,
    assetType,
    marketplaceId: item.id,
    sourceId: item.sourceId || item.payload?.rootId,
    localRootId: remapped.payload.rootId,
    localNodeIds: remapped.localNodeIds,
    name: item.name,
    author: item.author,
    description: item.description,
    trustLevel: item.trustLevel,
    sourceLabel: item.sourceLabel,
    activeVersion: 1,
    versions: [capabilityAssetVersion({ version: 1, payload: remapped.payload, includedSkills, source: "downloaded", trustLevel: item.trustLevel, installedAt, marketplaceId: item.id })],
    installedAt,
    updatedAt: installedAt,
  });
  if (assetType !== "template") {
    const current = normalizeCapabilityTemplate(registry.capabilityTemplate.current);
    current.groups.push(...remapped.payload.bundle.groups.map((node) => structuredClone(node)));
    current.modules.push(...remapped.payload.bundle.modules.map((node) => structuredClone(node)));
    const validation = validateCapabilityTemplate(current);
    if (!validation.valid) throw new Error(`能力资产安装失败：${validation.errors.join("；")}`);
    registry.capabilityTemplate.current = validation.bundle;
    registry.capabilityTemplate = normalizeCapabilityTemplateState(registry.capabilityTemplate, {
      customSlots: registry.customSlots,
      customSlotGroups: registry.customSlotGroups,
    });
    bumpRouteRevision(registry, { reason: "route_changed", sourceScopeType: assetType, sourceScopeId: remapped.payload.rootId });
  }
  registry.capabilityAssets = [...(registry.capabilityAssets ?? []), asset];
  await writeRegistry(root, registry);
  return { asset: publicCapabilityAsset(asset, registry), alreadyInstalled: false, updated: false, routeRevision: registry.routeRevision };
};

const removeManagedSkillVersionDirectories = async (root, entryId, versions = []) => {
  await Promise.all(versions.map((version) => rm(versionRoot(root, entryId, version.version), { recursive: true, force: true }).catch(() => {})));
};

const collapseManagedSkillHistory = async ({ root, registry, entry, versionRecord, write = true } = {}) => {
  const loaded = await loadEntryVersion(root, entry, versionRecord.version);
  const discarded = (entry.versions ?? []).filter((candidate) => candidate.version !== versionRecord.version);
  applyManagedSkillVersion(entry, loaded);
  entry.versions = [versionRecord];
  if (write) {
    bumpRouteRevision(registry, { reason: "skill_changed", sourceScopeType: "skill", sourceScopeId: entry.id });
    await writeRegistry(root, registry);
    await removeManagedSkillVersionDirectories(root, entry.id, discarded);
  }
  return discarded;
};

export const installMarketplaceSkill = async ({ id, shensiRoot = "", replaceLocalVersions = false } = {}) => {
  if (String(id || "").startsWith("remote:")) {
    const downloaded = await downloadRemoteMarketplaceArtifact(id);
    const artifact = downloaded.artifact;
    if (artifact.assetType === "skill") {
      if (artifact.packageFormat !== "shensi-skill-package-v1") throw new Error("远程 Skill 包格式不受支持");
      const parsedPackage = parseSkillPackage(downloaded.bytes);
      assertRemoteMarketplaceSkillIdentity({ artifactId: artifact.artifactId, skillId: parsedPackage.metadata.id });
      const installed = await installSkillPackage({ bytes: downloaded.bytes, origin: "downloaded", sourceType: "team_server", sourceLabel: "神思 Skill 广场" });
      await testManagedSkill({ id: installed.skill.id });
      const current = await findManagedEntry(installed.skill.id);
      current.entry.trustLevel = artifact.trustLevel === "official" ? "official" : artifact.trustLevel === "verified" ? "verified" : "community";
      current.entry.sourceType = "team_server";
      current.entry.sourceLabel = "神思 Skill 广场";
      const discarded = replaceLocalVersions
        ? await collapseManagedSkillHistory({ root: current.root, registry: current.registry, entry: current.entry, versionRecord: current.entry.versions.find((version) => version.version === current.entry.activeVersion), write: false })
        : [];
      await writeRegistry(current.root, current.registry);
      await removeManagedSkillVersionDirectories(current.root, current.entry.id, discarded);
      return { skill: publicSkill(current.entry), alreadyInstalled: false, verifiedDownload: true, replacedLocalHistory: replaceLocalVersions };
    }
    if (artifact.packageFormat !== CAPABILITY_ASSET_PACKAGE_FORMAT || !CAPABILITY_ASSET_TYPES.has(artifact.assetType)) throw new Error("远程能力资产包格式不受支持");
    let packagePayload;
    try { packagePayload = JSON.parse(downloaded.bytes.toString("utf8")); } catch { throw new Error("远程能力资产包不是有效 JSON"); }
    if (packagePayload.packageFormat !== CAPABILITY_ASSET_PACKAGE_FORMAT || packagePayload.assetType !== artifact.assetType) throw new Error("远程能力资产清单与签名记录不一致");
    const root = await ensureSkillStore();
    const registry = await readRegistry(root);
    return installMarketplaceCapabilityAsset({
      root,
      registry,
      item: {
        id,
        assetType: artifact.assetType,
        sourceId: String(packagePayload.id || artifact.artifactId),
        name: String(packagePayload.name || artifact.artifactId),
        author: String(packagePayload.author || "广场发布者"),
        description: String(packagePayload.description || ""),
        trustLevel: artifact.trustLevel === "official" ? "official" : artifact.trustLevel === "verified" ? "verified" : "community",
        sourceLabel: "神思 Skill 广场",
        payload: packagePayload.payload,
        includedSkills: packagePayload.includedSkills ?? [],
      },
      replaceLocalVersions,
    });
  }
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const item = marketplaceAllItems(registry).find((candidate) => candidate.id === id);
  if (!item) throw new Error("该广场项目不存在");
  if (marketplaceAssetType(item) !== "skill") return installMarketplaceCapabilityAsset({ item, root, registry, replaceLocalVersions });
  const existing = registry.skills.find((entry) => entry.id === marketplaceManagedSkillId(item));
  const content = await marketplaceContentForItem(item, shensiRoot);
  const packageFiles = await bundledMarketplacePackageFiles({ item, shensiRoot });
  if (!content) throw new Error("该广场 Skill 的安装包不可用");
  let installSource = installableMarketplaceSkillSource({ item, content });
  const incomingParsed = parseSkillMarkdown(installSource);
  const incomingMetadata = normalizeSkillMetadata(incomingParsed.metadata, { heading: incomingParsed.heading });
  const incomingFingerprint = skillPublicationFingerprint({ metadata: incomingMetadata, body: incomingParsed.body });
  const matchingUpstream = existing?.versions?.find((version) => version.upstreamId === item.id && version.upstreamFingerprint === incomingFingerprint);
  if (matchingUpstream) {
    const repairedFiles = await installMissingSkillPackageFiles({ root, entry: existing, version: matchingUpstream.version, packageFiles });
    if (repairedFiles.length) await testManagedSkill({ id: existing.id });
    if (!replaceLocalVersions) return { skill: publicSkill(existing), alreadyInstalled: true, updated: false };
    await collapseManagedSkillHistory({ root, registry, entry: existing, versionRecord: matchingUpstream });
    return { skill: publicSkill(existing), alreadyInstalled: true, updated: false, replacedLocalHistory: true };
  }
  const sameVersion = existing?.versions?.find((version) => String(version.version) === String(incomingMetadata.version));
  if (sameVersion?.hash === hashText(installSource)) {
    const repairedFiles = await installMissingSkillPackageFiles({ root, entry: existing, version: sameVersion.version, packageFiles });
    if (repairedFiles.length) await testManagedSkill({ id: existing.id });
    if (!replaceLocalVersions) return { skill: publicSkill(existing), alreadyInstalled: true, updated: false };
    await collapseManagedSkillHistory({ root, registry, entry: existing, versionRecord: sameVersion });
    return { skill: publicSkill(existing), alreadyInstalled: true, updated: false, replacedLocalHistory: true };
  }
  if (sameVersion) {
    const aliasedVersion = availableUpstreamVersion(existing, incomingMetadata.version);
    installSource = installSource.replace(/^(version\s*:\s*).+$/m, `$1${yamlString(aliasedVersion)}`);
  }
  const installed = await installSkillSource({
    content: installSource,
    packageFiles,
    origin: "downloaded",
    sourceType: item.sourceType,
    sourceLabel: item.sourceLabel,
  });
  await testManagedSkill({ id: installed.skill.id });
  const current = await findManagedEntry(installed.skill.id);
  current.entry.trustLevel = item.trustLevel;
  current.entry.sourceType = item.sourceType;
  current.entry.sourceLabel = item.sourceLabel;
  current.entry.upstreamType = "marketplace";
  current.entry.upstreamId = item.id;
  current.entry.upstreamVersion = String(item.version || incomingMetadata.version);
  for (const version of current.entry.versions ?? []) {
    if (version.version === current.entry.activeVersion) {
      version.trustLevel = item.trustLevel;
      version.sourceType = item.sourceType;
      version.upstreamId = item.id;
      version.upstreamVersion = String(item.version || incomingMetadata.version);
      version.upstreamFingerprint = incomingFingerprint;
    }
  }
  const discarded = replaceLocalVersions
    ? await collapseManagedSkillHistory({ root: current.root, registry: current.registry, entry: current.entry, versionRecord: current.entry.versions.find((version) => version.version === current.entry.activeVersion), write: false })
    : [];
  await writeRegistry(current.root, current.registry);
  await removeManagedSkillVersionDirectories(current.root, current.entry.id, discarded);
  await rm(join(versionRoot(current.root, current.entry.id, current.entry.activeVersion), "manifest.json"), { force: true });
  await ensureStandardSkillPackage(current.root, current.entry);
  return { skill: publicSkill(current.entry), alreadyInstalled: false, updated: Boolean(existing), replacedLocalHistory: replaceLocalVersions };
};

const findCapabilityAssetEntry = async (requestedId) => {
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const entry = (registry.capabilityAssets ?? []).find((asset) => asset.id === String(requestedId || ""));
  if (!entry) throw new Error("能力资产不存在");
  return { root, registry, entry };
};

export const loadManagedCapabilityAsset = async ({ id, version = 0, includePayload = false } = {}) => {
  const { registry, entry } = await findCapabilityAssetEntry(id);
  const record = Number(version)
    ? entry.versions.find((candidate) => candidate.version === Number(version))
    : capabilityAssetActiveRecord(entry);
  if (!record) throw new Error("能力资产版本不存在");
  return {
    ...publicCapabilityAsset(entry, registry),
    version: record.version,
    ...(includePayload ? {
      payload: structuredClone(record.payload),
      includedSkills: capabilityIncludedSkills(record.payload, registry, record.includedSkills),
    } : {}),
  };
};

export const deleteManagedCapabilityAssetVersion = async ({ id, version } = {}) => {
  const { root, registry, entry } = await findCapabilityAssetEntry(id);
  const selectedVersion = Number(version);
  const selected = (entry.versions ?? []).find((candidate) => Number(candidate.version) === selectedVersion);
  if (!selected) throw new Error("能力资产历史版本不存在");
  if (Number(entry.activeVersion) === selectedVersion) throw new Error("当前能力资产版本正在被面板使用，请先切换到其他版本");
  entry.versions = (entry.versions ?? []).filter((candidate) => Number(candidate.version) !== selectedVersion);
  await writeRegistry(root, registry);
  return { asset: publicCapabilityAsset(entry, registry), deletedVersion: selectedVersion };
};

export const testManagedCapabilityAsset = async ({ id } = {}) => {
  let found = await findCapabilityAssetEntry(id);
  let integrationTest = null;
  if (found.entry.integrationSkillId) {
    integrationTest = await testManagedSkill({ id: found.entry.integrationSkillId });
    found = await findCapabilityAssetEntry(id);
  }
  const { root, registry, entry } = found;
  const record = capabilityAssetActiveRecord(entry);
  if (!record) throw new Error("能力资产版本不存在");
  const test = capabilityAssetTestResult(registry, record.payload);
  entry.testStatus = test.passed ? "passed" : "failed";
  entry.testSummary = integrationTest
    ? `${test.summary}；整体插件 Skill：${integrationTest.test.summary}`
    : test.summary;
  entry.lastTestedAt = Date.now();
  await writeRegistry(root, registry);
  return {
    asset: publicCapabilityAsset(entry, registry),
    test: { ...test, summary: entry.testSummary, integrationSkillTested: Boolean(integrationTest) },
  };
};

export const exportManagedCapabilityAsset = async ({ id, version = 0 } = {}) => {
  const { entry } = await findCapabilityAssetEntry(id);
  const record = Number(version)
    ? entry.versions.find((candidate) => candidate.version === Number(version))
    : capabilityAssetActiveRecord(entry);
  if (!record) throw new Error("能力资产版本不存在");
  const packagePayload = {
    packageFormat: CAPABILITY_ASSET_PACKAGE_FORMAT,
    schemaVersion: 1,
    assetType: entry.assetType,
    id: entry.id,
    name: entry.name,
    author: entry.author,
    description: entry.description,
    version: record.version,
    sourceLabel: entry.sourceLabel,
    trustLevel: entry.trustLevel,
    hash: record.hash,
    payload: record.payload,
    includedSkills: record.includedSkills ?? [],
  };
  const bytes = Buffer.from(JSON.stringify(packagePayload, null, 2), "utf8");
  return {
    fileName: `${String(entry.name || entry.id).replace(/[\\/:*?"<>|]/g, "-")}-v${record.version}.shensi-capability.json`,
    mimeType: "application/vnd.shensi.capability+json",
    bytes,
  };
};

const clearCapabilityCopyAuthority = (payload = {}) => {
  const copy = structuredClone(payload);
  const clearNode = (node) => {
    if (!node) return;
    node.official = false;
    node.kernelManaged = false;
    node.marketplaceId = "";
    node.origin = "imported";
    node.sourceLabel = "本地可编辑副本";
    node.trustLevel = "local";
    node.prototypeId = "";
    node.prototypeName = "";
    node.prototypeFingerprint = "";
    node.derivativeCopy = false;
    node.changeSummary = "";
  };
  clearNode(copy.bundle.template);
  for (const group of copy.bundle.groups) clearNode(group);
  for (const module of copy.bundle.modules) {
    clearNode(module);
    for (const slot of module.slots) {
      slot.official = false;
      slot.kernelManaged = false;
    }
  }
  return normalizeCapabilityAssetPayload(copy, copy.rootType);
};

export const copyManagedCapabilityAssetForEditing = async ({ assetId = "", scopeType = "", scopeId = "" } = {}) => {
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const sourceAsset = assetId ? (registry.capabilityAssets ?? []).find((asset) => asset.id === String(assetId)) : null;
  if (assetId && !sourceAsset) throw new Error("能力资产不存在");
  const assetType = sourceAsset?.assetType || capabilityScopeType(scopeType);
  if (!CAPABILITY_ASSET_TYPES.has(assetType)) throw new Error("只能复制模块、模组或面板");
  const sourceRecord = sourceAsset ? capabilityAssetActiveRecord(sourceAsset) : null;
  const sourcePayload = sourceAsset
    ? normalizeCapabilityAssetPayload(sourceRecord?.payload, assetType)
    : capabilityAssetPayloadFromBundle(registry.capabilityTemplate.current, assetType, scopeId);
  const sourceRoot = capabilityTemplateNode(sourcePayload.bundle, assetType, sourcePayload.rootId);
  if (!sourceRoot) throw new Error("要复制的能力结构不存在");
  const newAssetId = capabilityLibraryId(assetType, `copy:${sourceAsset?.id || sourcePayload.rootId}`);
  const remapped = remapCapabilityAssetPayloadForInstall(sourcePayload, {
    assetId: newAssetId,
    item: {
      id: newAssetId,
      sourceLabel: "本地可编辑副本",
      trustLevel: "local",
      author: sourceAsset?.author || sourceRoot.author || "本地用户",
    },
  });
  const payload = clearCapabilityCopyAuthority(remapped.payload);
  const copiedRoot = capabilityTemplateNode(payload.bundle, assetType, payload.rootId);
  const sourceName = sourceAsset?.name || sourceRoot.name || `未命名${capabilityAssetTypeLabel(assetType)}`;
  copiedRoot.name = `${sourceName} 副本`;
  copiedRoot.prototypeId = sourceAsset?.sourceId || sourcePayload.rootId;
  copiedRoot.prototypeName = sourceName;
  copiedRoot.prototypeFingerprint = capabilityDerivativeFingerprint(payload);
  copiedRoot.derivativeCopy = true;
  copiedRoot.changeSummary = "";
  copiedRoot.author = sourceAsset?.author || sourceRoot.author || "本地用户";
  const normalizedPayload = normalizeCapabilityAssetPayload(payload, assetType);
  const includedSkills = sourceRecord?.includedSkills?.length
    ? sourceRecord.includedSkills
    : capabilityIncludedSkills(sourcePayload, registry);
  const installedAt = Date.now();
  const asset = normalizeStoredCapabilityAsset({
    id: newAssetId,
    assetType,
    marketplaceId: "",
    sourceId: sourceAsset?.sourceId || sourcePayload.rootId,
    localRootId: normalizedPayload.rootId,
    localNodeIds: remapped.localNodeIds,
    name: copiedRoot.name,
    author: copiedRoot.author,
    description: sourceAsset?.description || sourceRoot.description || "",
    origin: "imported",
    trustLevel: "local",
    sourceLabel: `可编辑副本：${sourceName}`,
    activeVersion: 1,
    versions: [capabilityAssetVersion({
      version: 1,
      payload: normalizedPayload,
      includedSkills,
      source: "imported",
      trustLevel: "local",
      installedAt,
    })],
    testStatus: "untested",
    testSummary: "可编辑副本尚未测试",
    installedAt,
    updatedAt: installedAt,
  });
  if (assetType !== "template") {
    const next = normalizeCapabilityTemplate(registry.capabilityTemplate.current);
    next.groups.push(...normalizedPayload.bundle.groups.map((node) => structuredClone(node)));
    next.modules.push(...normalizedPayload.bundle.modules.map((node) => structuredClone(node)));
    const validation = validateCapabilityTemplate(next);
    if (!validation.valid) throw new Error(`能力副本创建失败：${validation.errors.join("；")}`);
    registry.capabilityTemplate.current = validation.bundle;
    registry.capabilityTemplate = normalizeCapabilityTemplateState(registry.capabilityTemplate, {
      customSlots: registry.customSlots,
      customSlotGroups: registry.customSlotGroups,
    });
    const canonicalPayload = capabilityAssetPayloadFromBundle(registry.capabilityTemplate.current, assetType, normalizedPayload.rootId);
    const canonicalFingerprint = capabilityDerivativeFingerprint(canonicalPayload);
    const currentRoot = capabilityTemplateNode(registry.capabilityTemplate.current, assetType, normalizedPayload.rootId);
    currentRoot.prototypeFingerprint = canonicalFingerprint;
    const storedPayload = capabilityAssetPayloadFromBundle(registry.capabilityTemplate.current, assetType, normalizedPayload.rootId);
    const activeRecord = capabilityAssetActiveRecord(asset);
    activeRecord.payload = storedPayload;
    activeRecord.hash = hashText(JSON.stringify(storedPayload));
    bumpRouteRevision(registry, { reason: "route_changed", sourceScopeType: assetType, sourceScopeId: normalizedPayload.rootId });
  }
  registry.capabilityAssets = [...(registry.capabilityAssets ?? []), asset];
  await writeRegistry(root, registry);
  return {
    asset: publicCapabilityAsset(asset, registry),
    capabilityTemplate: publicCapabilityTemplateState(registry.capabilityTemplate),
    routeRevision: registry.routeRevision,
  };
};

export const activateManagedCapabilityTemplateAsset = async ({ id } = {}) => {
  const { root, registry, entry } = await findCapabilityAssetEntry(id);
  if (entry.assetType !== "template") throw new Error("只有面板资产可以切换启用");
  if (registry.activeCapabilityTemplateAssetId === entry.id) return {
    asset: publicCapabilityAsset(entry, registry),
    alreadyActive: true,
    capabilityTemplate: publicCapabilityTemplateState(registry.capabilityTemplate),
    routeRevision: registry.routeRevision,
  };
  const record = capabilityAssetActiveRecord(entry);
  const payload = normalizeCapabilityAssetPayload(record.payload, "template");
  const next = structuredClone(payload.bundle);
  Object.assign(next.template, {
    libraryAssetId: entry.id,
    marketplaceId: entry.marketplaceId,
    origin: "downloaded",
    sourceLabel: entry.sourceLabel,
    trustLevel: entry.trustLevel,
    author: entry.author,
  });
  registry.capabilityTemplate.current = normalizeCapabilityTemplate(next);
  registry.capabilityTemplate = normalizeCapabilityTemplateState(registry.capabilityTemplate, {
    customSlots: registry.customSlots,
    customSlotGroups: registry.customSlotGroups,
  });
  registry.activeCapabilityTemplateAssetId = entry.id;
  bumpRouteRevision(registry, { reason: "activated", sourceScopeType: "template", sourceScopeId: registry.capabilityTemplate.current.template.id });
  const activatedVersion = registry.capabilityTemplate.history.template.at(-1);
  await writeRegistry(root, registry);
  return {
    asset: publicCapabilityAsset(entry, registry),
    alreadyActive: false,
    activatedVersion: publicTemplateHistoryRecord(activatedVersion),
    capabilityTemplate: publicCapabilityTemplateState(registry.capabilityTemplate),
    routeRevision: registry.routeRevision,
    routeTopology: compileRouteTopology(registry),
  };
};

export const deleteManagedCapabilityAsset = async ({ id } = {}) => {
  const { root, registry, entry } = await findCapabilityAssetEntry(id);
  if (entry.assetType === "template" && registry.activeCapabilityTemplateAssetId === entry.id) throw new Error("当前正在运行的面板不能删除，请先切换到另一套面板或还原初始面板");
  let stagedSkillTrash = null;
  if (entry.assetType !== "template" && entry.localNodeIds.length) {
    const removedIds = new Set(entry.localNodeIds);
    const next = normalizeCapabilityTemplate(registry.capabilityTemplate.current);
    next.groups = next.groups.filter((group) => !removedIds.has(group.id));
    next.modules = next.modules.filter((module) => !removedIds.has(module.id));
    next.template.items = next.template.items.filter((item) => !removedIds.has(item.targetId));
    for (const group of next.groups) group.items = group.items.filter((item) => !removedIds.has(item.targetId));
    const validation = validateCapabilityTemplate(applyCapabilityKernelMechanisms(next));
    if (!validation.valid) throw new Error(`能力资产删除失败：${validation.errors.join("；")}`);
    registry.capabilityTemplate.current = validation.bundle;
    registry.capabilityTemplate = normalizeCapabilityTemplateState(registry.capabilityTemplate, {
      customSlots: registry.customSlots,
      customSlotGroups: registry.customSlotGroups,
    });
    bumpRouteRevision(registry, { reason: "route_changed", sourceScopeType: entry.assetType, sourceScopeId: entry.localRootId });
  }
  if (entry.integrationSkillId) {
    await pruneExpiredSkillTrash(root, registry);
    const managedId = entry.integrationSkillId.replace(/^user:/, "");
    const skillEntry = registry.skills.find((skill) => skill.id === managedId);
    if (skillEntry) stagedSkillTrash = await stageManagedSkillTrash({ root, registry, entry: skillEntry, capabilityAsset: entry });
  }
  registry.capabilityAssets = registry.capabilityAssets.filter((asset) => asset !== entry);
  try {
    await writeRegistry(root, registry);
  } catch (error) {
    if (stagedSkillTrash) await rename(stagedSkillTrash.archivePath, stagedSkillTrash.sourcePath).catch(() => {});
    throw error;
  }
  return {
    id: entry.id,
    deleted: true,
    trash: stagedSkillTrash ? publicSkillTrashEntry(stagedSkillTrash.trashEntry) : null,
    routeRevision: registry.routeRevision,
    routeTopology: compileRouteTopology(registry),
  };
};

const capabilityDerivativeFingerprint = (payload = {}) => {
  const normalized = normalizeCapabilityAssetPayload(payload);
  const transientNodeFields = new Set([
    "id", "nodeType", "name", "official", "kernelManaged", "prototypeId", "prototypeName",
    "prototypeFingerprint", "derivativeCopy", "changeSummary", "version", "createdAt", "updatedAt",
    "libraryAssetId", "marketplaceId", "origin", "sourceLabel", "trustLevel", "author", "items", "slots",
  ]);
  const transientRelationFields = new Set(["id", "name", "targetId", "relationScopeId", "createdAt", "updatedAt", "official", "kernelManaged"]);
  const cleanFields = (value = {}, ignored = transientNodeFields) => Object.fromEntries(Object.entries(value)
    .filter(([key]) => !ignored.has(key))
    .map(([key, field]) => [key, field]));
  const visiting = new Set();
  const canonicalNode = (nodeType, nodeId) => {
    const key = `${nodeType}:${nodeId}`;
    if (visiting.has(key)) throw new Error("能力资产存在循环引用，无法计算内容指纹");
    visiting.add(key);
    const node = capabilityTemplateNode(normalized.bundle, nodeType, nodeId);
    if (!node) throw new Error("能力资产节点缺失，无法计算内容指纹");
    const common = cleanFields(node);
    let result;
    if (nodeType === "module") {
      result = {
        type: "module",
        ...common,
        slots: (node.slots ?? []).map((slot) => ({ type: "slot", ...cleanFields(slot, transientRelationFields) })),
      };
    } else {
      result = {
        type: nodeType,
        ...common,
        items: (node.items ?? []).map((placement) => ({
          relation: cleanFields(placement, transientRelationFields),
          child: canonicalNode(placement.targetType, placement.targetId),
        })),
      };
    }
    visiting.delete(key);
    return result;
  };
  return hashText(JSON.stringify(canonicalNode(normalized.rootType, normalized.rootId)));
};

export const submitMarketplaceCapability = async ({ scopeType = "template", scopeId = "", assetId = "" } = {}) => {
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const publisherIsAdmin = registry.localPublisher?.role === "admin";
  const asset = assetId ? (registry.capabilityAssets ?? []).find((entry) => entry.id === String(assetId)) : null;
  if (assetId && !asset) throw new Error("能力资产不存在");
  const assetType = asset?.assetType || capabilityScopeType(scopeType);
  const assetRecord = asset ? capabilityAssetActiveRecord(asset) : null;
  const payload = asset
    ? normalizeCapabilityAssetPayload(assetRecord?.payload, assetType)
    : capabilityAssetPayloadFromBundle(registry.capabilityTemplate.current, assetType, scopeId);
  const test = capabilityAssetTestResult(registry, payload);
  if (!test.passed) throw new Error(`能力资产测试未通过：${test.summary}`);
  const rootNode = capabilityTemplateNode(payload.bundle, assetType, payload.rootId);
  const officialCandidates = publisherIsAdmin ? [] : officialCapabilityMarketplaceItems().filter((item) => item.assetType === assetType);
  const semanticHash = capabilityDerivativeFingerprint(payload);
  if (!publisherIsAdmin && rootNode?.official === true) throw new Error(`普通用户不能重复上传官方${capabilityAssetTypeLabel(assetType)}；微调后必须重命名，并填写原型与具体改动说明`);
  if (!publisherIsAdmin && !rootNode?.prototypeId && officialCandidates.some((item) => {
    const officialRoot = capabilityTemplateNode(item.payload.bundle, assetType, item.payload.rootId);
    return [item.name, officialRoot?.name].filter(Boolean).some((name) => name.trim().toLocaleLowerCase() === rootNode?.name?.trim().toLocaleLowerCase());
  })) {
    throw new Error(`普通用户不能发布与官方${capabilityAssetTypeLabel(assetType)}同名的内容；请重新命名，并填写原型与具体改动说明`);
  }
  if (!publisherIsAdmin && !rootNode?.prototypeId && officialCandidates.some((item) => capabilityDerivativeFingerprint(item.payload) === semanticHash)) {
    throw new Error(`该${capabilityAssetTypeLabel(assetType)}与官方原型内容相同，不能重复发布；微调后必须重新命名，并写清具体改动和与原型的区别`);
  }
  if (!publisherIsAdmin && rootNode?.prototypeId) {
    if (!rootNode.prototypeName || !rootNode.changeSummary) throw new Error(`衍生${capabilityAssetTypeLabel(assetType)}必须填写原型与具体改动说明`);
    if ([rootNode.prototypeName, `${rootNode.prototypeName} 副本`].includes(rootNode.name)) throw new Error(`衍生${capabilityAssetTypeLabel(assetType)}必须重命名后才能分享`);
    if (rootNode.prototypeFingerprint && rootNode.prototypeFingerprint === semanticHash) {
      throw new Error(`这个副本只修改了名称，实际内容和结构与原型完全相同；必须修改内容或结构，并填写具体改动说明后才能分享到广场`);
    }
    try {
      const stockPayload = capabilityAssetPayloadFromBundle(createInitialCapabilityTemplate(), assetType, rootNode.prototypeId);
      if (capabilityDerivativeFingerprint(stockPayload) === capabilityDerivativeFingerprint(payload)) {
        throw new Error(`衍生${capabilityAssetTypeLabel(assetType)}尚未修改实际能力内容，不能重复分享到广场`);
      }
    } catch (error) {
      if (/尚未修改实际能力内容/.test(String(error.message))) throw error;
    }
  }
  const version = Math.max(1, Number(assetRecord?.version || rootNode?.version) || 1);
  const sourceId = asset?.id || (assetType === "template" ? registry.capabilityTemplate.current.template.id : String(scopeId || payload.rootId));
  const id = `capability-publication:${assetType}:${sourceId.replace(/[^a-z0-9._:-]/gi, "-")}@${version}`;
  const hash = hashText(JSON.stringify(payload));
  const existing = (registry.capabilityMarketplaceSubmissions ?? []).find((publication) => publication.id === id);
  if (existing && existing.hash !== hash) throw new Error("当前版本号已有不同内容，请先保存新的节点版本再分享");
  const duplicateName = (registry.capabilityMarketplaceSubmissions ?? []).find((publication) => publication.status === "published"
    && publication.assetType === assetType
    && publication.sourceId !== sourceId
    && publication.name.trim().toLocaleLowerCase() === (asset?.name || rootNode?.name || "").trim().toLocaleLowerCase());
  if (!publisherIsAdmin && duplicateName) {
    throw new Error(`广场已存在同名${capabilityAssetTypeLabel(assetType)}：${duplicateName.name}；请重新命名，并在衍生内容中写清原型、具体改动和差异`);
  }
  const duplicate = (registry.capabilityMarketplaceSubmissions ?? []).find((publication) => (publication.semanticHash || capabilityDerivativeFingerprint(publication.payload)) === semanticHash && publication.id !== existing?.id);
  if (duplicate) throw new Error(`广场已存在内容完全相同的${capabilityAssetTypeLabel(assetType)}：${duplicate.name}`);
  const includedSkills = existing?.includedSkills?.length
    ? existing.includedSkills
    : capabilityIncludedSkills(payload, registry, assetRecord?.includedSkills);
  const publisher = publisherFields({
    authority: registry.localPublisher,
    publication: {
      ...existing,
      author: asset?.author || rootNode?.author || "本地用户",
      sourceType: "local_folder",
      sourceLabel: "本地能力面板库",
    },
    verified: true,
  });
  const publication = normalizeCapabilityMarketplaceSubmission({
    id,
    assetType,
    sourceId,
    name: asset?.name || rootNode?.name || `未命名${capabilityAssetTypeLabel(assetType)}`,
    author: publisher.author,
    version,
    description: asset?.description || rootNode?.description || "",
    payload,
    semanticHash,
    includedSkills,
    trustLevel: publisher.trustLevel,
    sourceType: publisher.sourceType,
    sourceLabel: publisher.sourceLabel,
    publisherAccountId: publisher.publisherAccountId,
    publisherRole: publisher.publisherRole,
    publishedAt: existing?.publishedAt || Date.now(),
    status: "published",
    yankedAt: 0,
    popularity: existing?.popularity || 0,
  });
  if (existing) Object.assign(existing, publication);
  else registry.capabilityMarketplaceSubmissions = [...(registry.capabilityMarketplaceSubmissions ?? []), publication];
  await writeRegistry(root, registry);
  return {
    publication: publicMarketplaceSubmission(publication),
    alreadyPublished: Boolean(existing),
    test,
  };
};

export const seedBundledCustomSkills = async ({ shensiRoot = "" } = {}) => {
  const root = await ensureSkillStore();
  const markerPath = join(root, BUNDLED_CUSTOM_SKILL_MARKER);
  const marker = await readFile(markerPath, "utf8").then((content) => JSON.parse(content)).catch(() => ({}));
  if (Number(marker.seedVersion) >= BUNDLED_CUSTOM_SKILL_SEED_VERSION) {
    return { seeded: [], skipped: BUNDLED_CUSTOM_SKILLS.map((skill) => skill.id), seedVersion: BUNDLED_CUSTOM_SKILL_SEED_VERSION };
  }
  const registry = await readRegistry(root);
  const seeded = [];
  const skipped = [];
  for (const bundled of BUNDLED_CUSTOM_SKILLS) {
    if (registry.skills.some((entry) => entry.id === bundled.id)) {
      skipped.push(bundled.id);
      continue;
    }
    const installed = await installSkillSource({
      content: bundled.content,
      origin: "imported",
      sourceType: "local_folder",
      sourceLabel: "神思预装自定义 Skill",
    });
    await testManagedSkill({ id: installed.skill.id });
    seeded.push(bundled.id);
  }
  for (const item of OFFICIAL_MARKETPLACE_SKILLS.filter((skill) => skill.preinstalled === true)) {
    const current = await readRegistry(root);
    if (current.skills.some((entry) => entry.id === marketplaceManagedSkillId(item))) {
      skipped.push(item.id);
      continue;
    }
    await installMarketplaceSkill({ id: item.id, shensiRoot });
    seeded.push(item.id);
  }
  await atomicWrite(markerPath, JSON.stringify({
    schemaVersion: 1,
    seedVersion: BUNDLED_CUSTOM_SKILL_SEED_VERSION,
    seededAt: Date.now(),
    skills: [
      ...BUNDLED_CUSTOM_SKILLS.map(({ id, version }) => ({ id, version })),
      ...OFFICIAL_MARKETPLACE_SKILLS.filter((skill) => skill.preinstalled === true).map(({ id, version }) => ({ id, version })),
    ],
  }, null, 2));
  return { seeded, skipped, seedVersion: BUNDLED_CUSTOM_SKILL_SEED_VERSION };
};

const normalizedSlotId = (value = "") => String(value).trim().replace(/^slot:/, "");
const normalizedGroupId = (value = "") => String(value).trim();
const bumpRouteRevision = (registry, history = {}) => {
  registry.routeRevision = Math.max(0, Number(registry.routeRevision) || 0) + 1;
  appendUnifiedRouteHistory(registry, history);
  return registry.routeRevision;
};

const normalizeCustomSlot = (input = {}, previous = null) => {
  const id = normalizedSlotId(input.id || previous?.id || `custom.${randomUUID()}`);
  const workspaceModes = [...new Set((Array.isArray(input.workspaceModes) ? input.workspaceModes : previous?.workspaceModes ?? [])
    .map((item) => String(item).trim()).filter((item) => ["project", "notebook", "general"].includes(item)))];
  const validCapabilities = new Set(allowedSkillCapabilities("general"));
  const capabilities = [...new Set((Array.isArray(input.capabilities) ? input.capabilities : previous?.capabilities ?? [])
    .map((item) => String(item).trim()).filter((item) => validCapabilities.has(item)))];
  const slotType = input.slotType === "multi" ? "multi" : "single";
  const secondarySkillIds = Array.from({ length: 3 }, (_, index) => String(
    Array.isArray(input.secondarySkillIds) ? input.secondarySkillIds[index] ?? "" : previous?.secondarySkillIds?.[index] ?? "",
  ).replace(/^user:/, "").trim()).map((id) => /^[a-z0-9][a-z0-9._:-]{2,119}$/i.test(id) ? id : "");
  const triggerDeclaration = validateTriggerDeclaration({
    triggerKeywords: input.triggerKeywords ?? previous?.triggerKeywords,
    triggerConditions: input.triggerConditions ?? previous?.triggerConditions,
    required: true,
  });
  const slot = {
    id,
    name: String(input.name ?? previous?.name ?? "").trim().slice(0, 100),
    description: String(input.description ?? previous?.description ?? "").trim().slice(0, 300),
    capabilityBoundary: String(input.capabilityBoundary ?? previous?.capabilityBoundary ?? "").trim().slice(0, 500),
    workspaceModes,
    capabilities,
    slotType,
    secondarySkillIds: slotType === "multi" ? secondarySkillIds : ["", "", ""],
    triggerKeywords: triggerDeclaration.keywords,
    triggerConditions: triggerDeclaration.conditions,
    skillId: String(input.skillId ?? previous?.skillId ?? "").replace(/^user:/, "").trim(),
    developerSkillId: previous?.developerSkillId ?? "",
    developerSkillName: previous?.developerSkillName ?? "",
    parentGroupId: String(input.parentGroupId ?? previous?.parentGroupId ?? inferredParentGroupId({ capabilities })).trim(),
    order: Number.isFinite(Number(input.order)) ? Number(input.order) : Number.isFinite(Number(previous?.order)) ? Number(previous.order) : 0,
    enabled: input.enabled === undefined ? previous?.enabled === true : input.enabled === true,
    createdAt: previous?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  const errors = [...triggerDeclaration.errors];
  if (!/^[a-z0-9][a-z0-9._-]{2,79}$/i.test(slot.id)) errors.push("插槽 ID 需为 3-80 位字母、数字、点、下划线或连字符");
  if (!slot.name) errors.push("缺少插槽名称");
  if (!slot.description) errors.push("缺少插槽用途说明");
  if (!slot.capabilityBoundary) errors.push("缺少插槽能力边界");
  if (!slot.workspaceModes.length) errors.push("必须选择使用模式");
  if (slot.capabilities.length !== 1) errors.push("一个插槽必须且只能对应一项能力");
  if (slot.slotType === "multi" && !PRIMARY_WRITER_SLOT_CAPABILITIES.has(slot.capabilities[0])) errors.push("多插槽仅用于主笔插槽；理论、设定、审查和资料类插槽必须使用单插槽");
  if (!slot.skillId && !slot.developerSkillId) errors.push("必须选择插槽使用的 Skill");
  if (errors.length) throw new Error(errors.join("；"));
  return slot;
};

export const upsertManagedCustomSlot = async (input = {}) => {
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const requestedId = normalizedSlotId(input.id);
  const previous = requestedId ? registry.customSlots.find((item) => item.id === requestedId) : null;
  const slot = normalizeCustomSlot(input, previous);
  const parentGroup = slot.parentGroupId ? allSlotGroups(registry).find((group) => group.id === slot.parentGroupId) : null;
  if (slot.parentGroupId && !parentGroup) throw new Error("插槽所在的插槽组不存在");
  const inheritedFixedGroup = [...groupLineage(slot.parentGroupId, registry)].reverse().find((group) => group.fixed && (group.allowedCapabilities ?? []).length);
  if (inheritedFixedGroup && !slot.capabilities.every((capability) => inheritedFixedGroup.allowedCapabilities.includes(capability))) {
    throw new Error(`该插槽组只允许：${inheritedFixedGroup.allowedCapabilities.join("、")}`);
  }
  const skill = slot.skillId ? registry.skills.find((item) => item.id === slot.skillId) : null;
  if (slot.skillId && !skill) throw new Error("插槽绑定的 Skill 不存在");
  if (skill && !slot.capabilities.every((capability) => (skill.capabilities ?? []).includes(capability))) throw new Error("该 Skill 未完整声明插槽所需能力，无法绑定");
  if (slot.enabled && !slot.developerSkillId && skill?.testStatus !== "passed") throw new Error("只有测试通过的 Skill 才能自动调用");
  for (const [index, secondarySkillId] of (slot.secondarySkillIds ?? []).entries()) {
    if (!secondarySkillId) continue;
    const secondarySkill = registry.skills.find((item) => item.id === secondarySkillId);
    if (!secondarySkill) throw new Error(`副插槽 ${index + 1} 绑定的 Skill 不存在`);
    if (!slot.capabilities.every((capability) => (secondarySkill.capabilities ?? []).includes(capability))) throw new Error(`副插槽 ${index + 1} 的 Skill 未声明主插槽能力`);
    if (slot.enabled && secondarySkill.testStatus !== "passed") throw new Error(`副插槽 ${index + 1} 的 Skill 需要先测试通过`);
  }
  const previousParentGroupId = previous?.parentGroupId ?? "";
  if (previous && previousParentGroupId !== slot.parentGroupId) {
    for (const group of registry.customSlotGroups) {
      if (group.leaderSlotId === slot.id) group.leaderSlotId = "";
    }
  }
  const stableSlotOrder = (left, right) => Number(left.order) - Number(right.order)
    || Number(left.createdAt) - Number(right.createdAt)
    || left.name.localeCompare(right.name, "zh-CN")
    || left.id.localeCompare(right.id, "en-US");
  const previousSiblingIndex = previous
    ? registry.customSlots
      .filter((item) => (item.parentGroupId || "") === previousParentGroupId)
      .sort(stableSlotOrder)
      .findIndex((item) => item.id === previous.id)
    : -1;
  registry.customSlots = registry.customSlots.filter((item) => item.id !== slot.id);
  if (previous && previousParentGroupId !== slot.parentGroupId) {
    registry.customSlots
      .filter((item) => (item.parentGroupId || "") === previousParentGroupId)
      .sort(stableSlotOrder)
      .forEach((item, index) => { item.order = index; });
  }
  const targetSiblings = registry.customSlots
    .filter((item) => (item.parentGroupId || "") === (slot.parentGroupId || ""))
    .sort(stableSlotOrder);
  const requestedOrder = Number.isFinite(Number(input.order))
    ? Number(input.order)
    : previous && previousParentGroupId === slot.parentGroupId ? previousSiblingIndex : targetSiblings.length;
  const targetOrder = Math.max(0, Math.min(targetSiblings.length, requestedOrder));
  targetSiblings.splice(targetOrder, 0, slot);
  targetSiblings.forEach((item, index) => { item.order = index; });
  if (previous) {
    Object.assign(previous, slot);
    registry.customSlots.push(previous);
  } else registry.customSlots.push(slot);
  bumpRouteRevision(registry, { reason: "slot_saved", sourceScopeType: "slot", sourceScopeId: slot.id });
  await writeRegistry(root, registry);
  return { slot: publicCustomSlot(slot, registry), routeRevision: registry.routeRevision };
};

export const setManagedCustomSlotEnabled = async ({ id, enabled } = {}) => {
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const slot = registry.customSlots.find((item) => item.id === normalizedSlotId(id));
  if (!slot) throw new Error("自定义插槽不存在");
  const skill = registry.skills.find((item) => item.id === slot.skillId);
  if (enabled && !slot.developerSkillId && skill?.testStatus !== "passed") throw new Error("只有测试通过的 Skill 才能自动调用");
  slot.enabled = Boolean(enabled);
  slot.updatedAt = Date.now();
  bumpRouteRevision(registry, { reason: slot.enabled ? "slot_enabled" : "slot_disabled", sourceScopeType: "slot", sourceScopeId: slot.id });
  await writeRegistry(root, registry);
  return { slot: publicCustomSlot(slot, registry), routeRevision: registry.routeRevision };
};

export const deleteManagedCustomSlot = async ({ id } = {}) => {
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const slot = registry.customSlots.find((item) => item.id === normalizedSlotId(id));
  if (!slot) throw new Error("自定义插槽不存在");
  registry.customSlots = registry.customSlots.filter((item) => item !== slot);
  for (const group of registry.customSlotGroups) {
    if (group.leaderSlotId === slot.id) group.leaderSlotId = "";
  }
  bumpRouteRevision(registry, { reason: "slot_deleted", sourceScopeType: "slot", sourceScopeId: slot.id });
  await writeRegistry(root, registry);
  return { id: slot.id, deleted: true, routeRevision: registry.routeRevision };
};

const normalizeCustomGroup = (input = {}, previous = null) => ({
  id: normalizedGroupId(input.id || previous?.id || `custom-group.${randomUUID()}`),
  name: String(input.name ?? previous?.name ?? "").trim().slice(0, 100),
  description: String(input.description ?? previous?.description ?? "").trim().slice(0, 300),
  parentGroupId: String(input.parentGroupId ?? previous?.parentGroupId ?? "").trim(),
  groupType: SLOT_GROUP_TYPES.has(input.groupType) ? input.groupType : previous?.groupType ?? "parallel",
  leaderSlotId: String(input.leaderSlotId ?? previous?.leaderSlotId ?? "").trim(),
  createdAt: previous?.createdAt ?? Date.now(),
  updatedAt: Date.now(),
});

const customGroupDescendantIds = (registry, groupId) => {
  const descendants = new Set([groupId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of registry.customSlotGroups ?? []) {
      if (!descendants.has(group.parentGroupId) || descendants.has(group.id)) continue;
      descendants.add(group.id);
      changed = true;
    }
  }
  return descendants;
};

export const upsertManagedCustomSlotGroup = async (input = {}) => {
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const requestedId = normalizedGroupId(input.id);
  if (FIXED_GROUP_IDS.has(requestedId)) throw new Error("预设插槽组不能修改");
  const previous = requestedId ? registry.customSlotGroups.find((group) => group.id === requestedId) : null;
  const group = normalizeCustomGroup(input, previous);
  const errors = [];
  if (!/^[a-z0-9][a-z0-9._:-]{2,119}$/i.test(group.id)) errors.push("插槽组 ID 需为 3-120 位字母、数字、点、冒号、下划线或连字符");
  if (!group.name) errors.push("缺少插槽组名称");
  if (group.parentGroupId && !allSlotGroups(registry).some((item) => item.id === group.parentGroupId)) errors.push("上级插槽组不存在");
  if (group.parentGroupId === group.id) errors.push("插槽组不能以自身作为上级");
  if (previous && customGroupDescendantIds(registry, group.id).has(group.parentGroupId)) errors.push("插槽组不能移动到自己的下级");
  if (group.groupType === "parallel" && group.leaderSlotId) errors.push("并行插槽组不能设置上位插槽");
  if (group.leaderSlotId && !registry.customSlots.some((slot) => slot.id === group.leaderSlotId && slot.parentGroupId === group.id)) errors.push("上位插槽必须是该组织插槽组内的直接插槽");
  if (errors.length) throw new Error(errors.join("；"));
  if (previous) Object.assign(previous, group);
  else registry.customSlotGroups.push(group);
  bumpRouteRevision(registry, { reason: "slot_group_saved", sourceScopeType: "slot-group", sourceScopeId: group.id });
  await writeRegistry(root, registry);
  return { group: publicCustomGroup(group, registry), routeRevision: registry.routeRevision };
};

export const deleteManagedCustomSlotGroup = async ({ id } = {}) => {
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const groupId = normalizedGroupId(id);
  if (FIXED_GROUP_IDS.has(groupId)) throw new Error("预设插槽组不能删除");
  const group = registry.customSlotGroups.find((item) => item.id === groupId);
  if (!group) throw new Error("自定义插槽组不存在");
  const removedGroupIds = customGroupDescendantIds(registry, groupId);
  const removedSlots = registry.customSlots.filter((slot) => removedGroupIds.has(slot.parentGroupId));
  registry.customSlotGroups = registry.customSlotGroups.filter((item) => !removedGroupIds.has(item.id));
  registry.customSlots = registry.customSlots.filter((slot) => !removedGroupIds.has(slot.parentGroupId));
  bumpRouteRevision(registry, { reason: "slot_group_deleted", sourceScopeType: "slot-group", sourceScopeId: groupId });
  await writeRegistry(root, registry);
  return {
    id: groupId,
    deleted: true,
    deletedGroupCount: removedGroupIds.size,
    deletedSlotCount: removedSlots.length,
    routeRevision: registry.routeRevision,
  };
};

const capabilityTemplateHistoryBucket = (state, scopeType, scopeId) => {
  if (scopeType === "template") return state.history.template;
  const collection = scopeType === "group" ? state.history.groups : state.history.modules;
  if (!collection[scopeId]) collection[scopeId] = [];
  return collection[scopeId];
};

const capabilityTemplateSnapshotForScope = (bundle, scopeType, scopeId) => {
  if (scopeType === "template") return bundle;
  return capabilityTemplateNode(bundle, scopeType, scopeId);
};

const appendCapabilityTemplateHistory = (state, { scopeType, scopeId, reason = "saved" }) => {
  const bucket = capabilityTemplateHistoryBucket(state, scopeType, scopeId);
  const snapshot = capabilityTemplateSnapshotForScope(state.current, scopeType, scopeId);
  if (!snapshot) throw new Error(scopeType === "group" ? "模组不存在" : scopeType === "module" ? "模块不存在" : "面板不存在");
  const version = bucket.reduce((max, entry) => Math.max(max, Number(entry.version) || 0), 0) + 1;
  const versionedNode = scopeType === "template" ? snapshot.template : snapshot;
  versionedNode.version = version;
  versionedNode.updatedAt = Date.now();
  const record = capabilityTemplateHistoryRecord({ scopeType, scopeId, version, snapshot: scopeType === "template" ? state.current : snapshot, reason });
  bucket.push(record);
  if (bucket.length > TEMPLATE_HISTORY_LIMIT) bucket.splice(0, bucket.length - TEMPLATE_HISTORY_LIMIT);
  state.updatedAt = Date.now();
  return record;
};

const capabilityRouteNodeMap = (bundle = {}) => {
  if (!bundle?.template) return new Map();
  const normalized = normalizeCapabilityTemplate(bundle);
  const nodes = new Map();
  const add = (type, node = {}, parentId = "") => {
    if (!node?.id) return;
    nodes.set(`${type}:${node.id}`, {
      type,
      id: node.id,
      name: node.name || node.id,
      parentId,
      fingerprint: hashText(JSON.stringify(node)),
      capabilities: type === "module"
        ? [...new Set((node.slots ?? []).flatMap((slot) => slot.capabilities ?? []))]
        : type === "slot" ? [...new Set(node.capabilities ?? [])] : [],
    });
  };
  add("template", normalized.template);
  for (const group of normalized.groups) add("group", group);
  for (const module of normalized.modules) {
    add("module", module);
    for (const slot of module.slots ?? []) add("slot", slot, module.id);
  }
  return nodes;
};

const customRouteNodeMap = (routeSnapshot = {}) => {
  routeSnapshot = routeSnapshot && typeof routeSnapshot === "object" ? routeSnapshot : {};
  const nodes = new Map();
  for (const group of routeSnapshot.customSlotGroups ?? []) {
    nodes.set(`slot-group:${group.id}`, {
      type: "slot-group",
      id: group.id,
      name: group.name || group.id,
      parentId: group.parentGroupId || "",
      fingerprint: hashText(JSON.stringify(group)),
      capabilities: [],
    });
  }
  for (const slot of routeSnapshot.customSlots ?? []) {
    nodes.set(`custom-slot:${slot.id}`, {
      type: "custom-slot",
      id: slot.id,
      name: slot.name || slot.id,
      parentId: slot.parentGroupId || "",
      fingerprint: hashText(JSON.stringify(slot)),
      capabilities: [...new Set(slot.capabilities ?? [])],
    });
  }
  return nodes;
};

const capabilityRouteDiff = ({ previousRecord = null, currentBundle, currentRouteSnapshot, topologyHash = "" } = {}) => {
  const previousNodes = new Map([
    ...capabilityRouteNodeMap(previousRecord?.snapshot).entries(),
    ...customRouteNodeMap(previousRecord?.routeSnapshot).entries(),
  ]);
  const currentNodes = new Map([
    ...capabilityRouteNodeMap(currentBundle).entries(),
    ...customRouteNodeMap(currentRouteSnapshot).entries(),
  ]);
  const changes = [];
  const affectedNodeIds = new Set();
  const affectedCapabilities = new Set();
  for (const key of new Set([...previousNodes.keys(), ...currentNodes.keys()])) {
    const before = previousNodes.get(key);
    const after = currentNodes.get(key);
    if (before?.fingerprint === after?.fingerprint) continue;
    const node = after || before;
    const change = !before ? "added" : !after ? "removed" : "updated";
    changes.push({ type: node.type, id: node.id, name: node.name, parentId: node.parentId || "", change });
    affectedNodeIds.add(node.id);
    if (node.parentId) affectedNodeIds.add(node.parentId);
    for (const capability of [...(before?.capabilities ?? []), ...(after?.capabilities ?? [])]) affectedCapabilities.add(capability);
  }
  const changeLabels = { added: "新增", removed: "删除", updated: "修改" };
  return {
    schemaVersion: 1,
    previousRouteRevision: Math.max(0, Number(previousRecord?.routeRevision) || 0),
    previousTopologyHash: String(previousRecord?.topologyHash || ""),
    topologyChanged: Boolean(previousRecord?.topologyHash) && previousRecord.topologyHash !== topologyHash,
    changes: changes.slice(0, 200),
    affectedNodeIds: [...affectedNodeIds].slice(0, 400),
    affectedCapabilities: [...affectedCapabilities].sort().slice(0, 300),
    summary: changes.length
      ? changes.slice(0, 12).map((entry) => `${changeLabels[entry.change] || "调整"}${entry.type === "group" ? "模组" : entry.type === "module" ? "模块" : entry.type.includes("slot") ? "插槽" : "面板"}“${entry.name}”`)
      : ["路由配置重新编译，面板结构未改变"],
  };
};

const appendUnifiedRouteHistory = (registry, {
  reason = "route_changed",
  sourceScopeType = "route",
  sourceScopeId = "",
  restoredFromRouteRevision = 0,
  adaptationActions = [],
} = {}) => {
  if (!registry.capabilityTemplate?.current) return null;
  const state = registry.capabilityTemplate;
  const bucket = capabilityTemplateHistoryBucket(state, "template", state.current.template.id);
  const previousRecord = bucket.at(-1) || null;
  const routeSnapshot = {
    customSlots: structuredClone(registry.customSlots ?? []),
    customSlotGroups: structuredClone(registry.customSlotGroups ?? []),
  };
  const version = bucket.reduce((maximum, entry) => Math.max(maximum, Number(entry.version) || 0), 0) + 1;
  // The template version is part of the topology payload. Update it before
  // hashing so the history record, runtime catalog and generated route all
  // bind to the same immutable topology hash.
  state.current.template.version = version;
  state.current.template.updatedAt = Date.now();
  const routeTopology = compileRouteTopology(registry);
  const lint = applyAdaptiveNativeFallbackToLint(lintCapabilityTemplateReachability(state.current, {
    fixedSlots: listFixedSkillSlots(),
    userSkills: registry.skills,
  }), adaptationActions);
  const routingAudit = capabilityTemplateRoutingAudit({
    bundle: state.current,
    lint,
    routeTopology,
    fixedSlots: listFixedSkillSlots(),
    userSkills: registry.skills,
    adaptationActions,
  });
  const routeDiff = capabilityRouteDiff({
    previousRecord,
    currentBundle: state.current,
    currentRouteSnapshot: routeSnapshot,
    topologyHash: routeTopology.hash || "",
  });
  const record = capabilityTemplateHistoryRecord({
    scopeType: "template",
    scopeId: state.current.template.id,
    version,
    snapshot: state.current,
    reason,
    routeRevision: registry.routeRevision,
    topologyHash: routeTopology.hash || "",
    routingAudit,
    routeDiff,
    routeSnapshot,
    sourceScopeType,
    sourceScopeId,
    restoredFromRouteRevision,
  });
  bucket.push(record);
  if (bucket.length > TEMPLATE_HISTORY_LIMIT) bucket.splice(0, bucket.length - TEMPLATE_HISTORY_LIMIT);
  state.updatedAt = Date.now();
  return record;
};

const normalizeCapabilityTemplateSaveScope = ({ scopeType, scopeId, bundle }) => {
  if (!["template", "group", "module"].includes(scopeType)) throw new Error("未知的模板保存范围");
  const kernelErrors = capabilityKernelMutationErrors(bundle);
  if (kernelErrors.length) throw new Error(kernelErrors.join("；"));
  const validation = validateCapabilityTemplate(bundle);
  if (!validation.valid) throw new Error(`面板结构校验失败：${validation.errors.join("；")}`);
  const effectiveScopeId = scopeType === "template" ? validation.bundle.template.id : String(scopeId || "");
  if (!capabilityTemplateSnapshotForScope(validation.bundle, scopeType, effectiveScopeId)) throw new Error("要保存的面板节点不存在");
  return { scopeType, scopeId: effectiveScopeId, bundle: validation.bundle };
};

const adaptCapabilityTemplateBindingsForSave = (bundle, { fixedSlots = [], userSkills = [], previousBundle = null } = {}) => {
  // Do not persist empty placeholders left by an older client or by a
  // cancelled add-slot picker. Explicitly removed slots are absent from the
  // bundle and therefore cannot be restored by the binding adapter.
  const adapted = pruneCapabilityTemplateEmptySlots(bundle);
  const availableFixedSlots = fixedSlots.filter((slot) => slot.developerDefault !== false);
  const fixedSlotIds = new Set(availableFixedSlots.map((slot) => slot.id));
  const fixedById = new Map(availableFixedSlots.map((slot) => [slot.id, slot]));
  const usersById = new Map(userSkills.flatMap((skill) => [
    [String(skill.id || ""), skill],
    [String(skill.id || "").replace(/^user:/, ""), skill],
  ]));
  const previousSlots = new Map(normalizeCapabilityTemplate(previousBundle || adapted).modules
    .flatMap((module) => module.slots.map((slot) => [slot.id, slot])));
  const actions = [];
  for (const module of adapted.modules) {
    for (const slot of module.slots) {
      if (slot.skillId) {
        const configuredId = String(slot.skillId || "");
        const user = usersById.get(configuredId) || usersById.get(configuredId.replace(/^user:/, ""));
        const fixed = fixedById.get(slot.fixedSlotId || configuredId);
        const officialReady = /^(?:builtin|official):/.test(configuredId) && fixed?.developerDefault !== false;
        const personalReady = Boolean(user && user.testStatus === "passed");
        const fallbackReady = slot.allowOfficialFallback === true
          && Boolean(slot.fixedSlotId)
          && fixedById.get(slot.fixedSlotId)?.developerDefault !== false;
        if (officialReady || personalReady || fallbackReady) continue;
        const previousSlot = previousSlots.get(slot.id);
        const staleExistingBinding = Boolean(previousSlot && String(previousSlot.skillId || "") === configuredId);
        if (!staleExistingBinding) continue;
        actions.push({
          action: "retain_stale_binding_use_native_fallback",
          moduleId: module.id,
          slotId: slot.id,
          skillId: configuredId,
        });
      }
      if (slot.skillId) continue;
      const inferredFixedSlot = slot.fixedSlotId && fixedSlotIds.has(slot.fixedSlotId)
        ? availableFixedSlots.find((candidate) => candidate.id === slot.fixedSlotId)
        : slot.capabilities.length
          ? availableFixedSlots.filter((candidate) => slot.capabilities.every((capability) => candidate.replacementCapabilities?.includes(capability))).length === 1
            ? availableFixedSlots.find((candidate) => slot.capabilities.every((capability) => candidate.replacementCapabilities?.includes(capability)))
            : null
          : null;
      if (!inferredFixedSlot) continue;
      slot.fixedSlotId = inferredFixedSlot.id;
      slot.skillId = inferredFixedSlot.id;
      slot.allowOfficialFallback = true;
      actions.push({
        action: "restore_official_binding",
        moduleId: module.id,
        slotId: slot.id,
        skillId: inferredFixedSlot.id,
      });
    }
  }
  return { bundle: normalizeCapabilityTemplate(adapted), actions };
};

const applyAdaptiveNativeFallbackToLint = (lint = {}, adaptationActions = []) => {
  const nativeFallbackSlotIds = new Set(adaptationActions
    .filter((entry) => entry.action === "retain_stale_binding_use_native_fallback")
    .map((entry) => entry.slotId));
  if (!nativeFallbackSlotIds.size) return lint;
  const issues = (lint.issues || []).map((issue) => issue.code === "invalid_implementation" && nativeFallbackSlotIds.has(issue.nodeId)
    ? {
      ...issue,
      severity: "warning",
      code: "stale_binding_native_fallback",
      message: `${issue.message}；保存后保留绑定记录，本轮无法调用时由所选模型原生能力后备，不会静默重装已删除的 Skill`,
    }
    : issue);
  const errors = issues.filter((issue) => issue.severity === "error").map((issue) => issue.message);
  const warnings = issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message);
  return { ...lint, valid: errors.length === 0, issues, errors, warnings };
};

const capabilityTemplateRoutingAudit = ({ bundle, lint, routeTopology, fixedSlots = [], userSkills = [], adaptationActions = [] } = {}) => {
  const fixedById = new Map(fixedSlots.map((slot) => [slot.id, slot]));
  const usersById = new Map(userSkills.flatMap((skill) => [
    [String(skill.id || ""), skill],
    [String(skill.id || "").replace(/^user:/, ""), skill],
  ]));
  const capabilities = new Set();
  const nativeFallbackSlotIds = new Set(adaptationActions
    .filter((entry) => entry.action === "retain_stale_binding_use_native_fallback")
    .map((entry) => entry.slotId));
  const invocations = [];
  for (const module of bundle.modules) {
    for (const slot of module.slots) {
      const configuredId = String(slot.skillId || "");
      const fixed = fixedById.get(slot.fixedSlotId || configuredId);
      const user = usersById.get(configuredId) || usersById.get(configuredId.replace(/^user:/, ""));
      const slotCapabilities = slot.capabilities.length
        ? slot.capabilities
        : user?.capabilities?.length ? user.capabilities : fixed?.replacementCapabilities ?? [];
      for (const capability of slotCapabilities) capabilities.add(capability);
      const officialReady = /^(?:builtin|official):/.test(configuredId) && fixed?.developerDefault !== false;
      const personalReady = Boolean(user && user.testStatus === "passed");
      const fallbackReady = slot.allowOfficialFallback === true
        && Boolean(slot.fixedSlotId)
        && fixedById.get(slot.fixedSlotId)?.developerDefault !== false;
      const nativeFallbackReady = slotCapabilities.length > 0
        && (!configuredId || nativeFallbackSlotIds.has(slot.id));
      invocations.push({
        moduleId: module.id,
        slotId: slot.id,
        skillId: configuredId,
        capabilityCount: slotCapabilities.length,
        callable: officialReady || personalReady || fallbackReady || nativeFallbackReady,
        fallback: !officialReady && !personalReady && fallbackReady,
        nativeFallback: nativeFallbackReady,
      });
    }
  }
  const relationCounts = [bundle.template, ...bundle.groups, ...bundle.modules].reduce((counts, node) => {
    counts[node.relationType] = (counts[node.relationType] || 0) + 1;
    return counts;
  }, {});
  const callableCount = invocations.filter((entry) => entry.callable).length;
  const inactiveCapabilitySlots = invocations.filter((entry) => !entry.callable && entry.capabilityCount > 0);
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    valid: lint.valid === true && routeTopology?.capabilityTemplate?.valid !== false && inactiveCapabilitySlots.length === 0,
    templateCapabilityCount: capabilities.size,
    templateCapabilities: [...capabilities].sort(),
    groupCount: bundle.groups.length,
    moduleCount: bundle.modules.length,
    slotCount: invocations.length,
    callableSlotCount: callableCount,
    fallbackSlotCount: invocations.filter((entry) => entry.fallback).length,
    nativeFallbackSlotCount: invocations.filter((entry) => entry.nativeFallback).length,
    inactiveSlotCount: inactiveCapabilitySlots.length,
    relationCounts,
    lintIssueCount: lint.issues?.length ?? 0,
    lintErrorCount: lint.errors?.length ?? 0,
    lintWarningCount: lint.warnings?.length ?? 0,
    topologyHash: routeTopology?.hash || "",
    adaptationActions,
    autoRecompiled: true,
  };
};

export const saveManagedCapabilityTemplate = async ({ bundle, scopeType = "template", scopeId = "", reason = "saved", shensiRoot = "" } = {}) => {
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const adapted = adaptCapabilityTemplateBindingsForSave(bundle, {
    fixedSlots: listFixedSkillSlots(),
    userSkills: registry.skills,
    previousBundle: registry.capabilityTemplate.current,
  });
  const normalized = normalizeCapabilityTemplateSaveScope({ scopeType, scopeId, bundle: adapted.bundle });
  const preflightLint = applyAdaptiveNativeFallbackToLint(lintCapabilityTemplateReachability(normalized.bundle, {
    fixedSlots: listFixedSkillSlots(),
    userSkills: registry.skills,
  }), adapted.actions);
  const preflightAudit = capabilityTemplateRoutingAudit({
    bundle: normalized.bundle,
    lint: preflightLint,
    routeTopology: { capabilityTemplate: { valid: true } },
    fixedSlots: listFixedSkillSlots(),
    userSkills: registry.skills,
    adaptationActions: adapted.actions,
  });
  if (!preflightAudit.valid) {
    const details = preflightLint.errors.length
      ? preflightLint.errors.join("；")
      : `${preflightAudit.inactiveSlotCount} 个声明了面板能力的插槽没有可调用 Skill 或官方回退`;
    throw new Error(`面板路由自适应检查失败：${details}；未保存不可调用的面板版本`);
  }
  registry.capabilityTemplate.current = normalized.bundle;
  registry.capabilityTemplate = normalizeCapabilityTemplateState(registry.capabilityTemplate, {
    customSlots: registry.customSlots,
    customSlotGroups: registry.customSlotGroups,
  });
  const localRecord = normalized.scopeType === "template" ? null : appendCapabilityTemplateHistory(registry.capabilityTemplate, {
    scopeType: normalized.scopeType,
    scopeId: normalized.scopeId,
    reason: reason === "restored" ? "restored" : "saved",
  });
  syncCapabilityAssetsFromCurrent(registry, { scopeType: normalized.scopeType, scopeId: normalized.scopeId });
  bumpRouteRevision(registry, {
    reason: reason === "restored" ? "restored" : "saved",
    sourceScopeType: normalized.scopeType,
    sourceScopeId: normalized.scopeId,
    adaptationActions: adapted.actions,
  });
  const routeRecord = registry.capabilityTemplate.history.template.at(-1);
  const record = localRecord || routeRecord;
  await writeRegistry(root, registry);
  const catalog = await buildManagedSkillCatalog({ shensiRoot });
  const lint = applyAdaptiveNativeFallbackToLint(lintCapabilityTemplateReachability(catalog.capabilityTemplate.current, {
    fixedSlots: catalog.fixedSlots,
    userSkills: catalog.user,
  }), adapted.actions);
  if (!lint.valid) throw new Error(`面板保存后的实时路由复检失败：${lint.errors.join("；")}`);
  const routingAudit = capabilityTemplateRoutingAudit({
    bundle: catalog.capabilityTemplate.current,
    lint,
    routeTopology: catalog.routeTopology,
    fixedSlots: catalog.fixedSlots,
    userSkills: catalog.user,
    adaptationActions: adapted.actions,
  });
  return {
    capabilityTemplate: catalog.capabilityTemplate,
    savedVersion: publicTemplateHistoryRecord(record),
    routeVersion: publicTemplateHistoryRecord(routeRecord),
    routeRevision: catalog.routeRevision,
    routeTopology: catalog.routeTopology,
    lint,
    routingAudit,
    adaptiveRouteUpdate: {
      checked: true,
      routeReady: routingAudit.valid,
      recompiled: true,
      repairedBindingCount: adapted.actions.length,
      topologyHash: routingAudit.topologyHash,
    },
  };
};

const matchingUnifiedRouteHistoryRecord = (registry, routeRevision, topologyHash) => {
  const bucket = registry.capabilityTemplate?.history?.template ?? [];
  return [...bucket].reverse().find((entry) => (
    Number(entry.routeRevision) === Number(routeRevision)
    && String(entry.topologyHash || "").toLowerCase() === String(topologyHash || "").toLowerCase()
  )) || null;
};

const appendRouteDocumentRecord = (registry, value = {}, { makeCurrent = false } = {}) => {
  registry.routeDocument = normalizeRouteDocumentState(registry.routeDocument);
  const record = normalizeRouteDocumentRecord(value);
  registry.routeDocument.history.push(record);
  if (registry.routeDocument.history.length > ROUTE_DOCUMENT_HISTORY_LIMIT) {
    registry.routeDocument.history.splice(0, registry.routeDocument.history.length - ROUTE_DOCUMENT_HISTORY_LIMIT);
  }
  if (makeCurrent && record.status === "accepted") registry.routeDocument.currentId = record.id;
  return record;
};

export const commitManagedTaskRouteDocumentCandidate = async ({ candidate = {}, routeRevision = 0, topologyHash = "", model = {} } = {}) => {
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const topology = compileRouteTopology(registry);
  const expectedRevision = Math.max(0, Number(routeRevision) || 0);
  const expectedHash = String(topologyHash || "").trim().toLowerCase();
  const validation = validateTaskRouteDocumentCandidate(candidate, {
    routeRevision: expectedRevision,
    topologyHash: expectedHash,
    bundle: registry.capabilityTemplate.current,
  });
  if (Number(topology.revision) !== expectedRevision || String(topology.hash || "").toLowerCase() !== expectedHash) {
    validation.errors.unshift("Skill 面板已在另一个窗口中变化，候选没有激活");
    validation.valid = false;
  }
  if (!validation.valid) {
    const rejected = new Error(`动态任务路由校验失败：${validation.errors.join("；")}`);
    rejected.code = "TASK_ROUTE_DOCUMENT_REJECTED";
    rejected.statusCode = 422;
    rejected.validation = validation;
    throw rejected;
  }
  const record = appendRouteDocumentRecord(registry, {
    id: `route-document:${expectedRevision}:${randomUUID()}`,
    status: "accepted",
    routeRevision: expectedRevision,
    topologyHash: expectedHash,
    content: validation.document,
    contentHash: validation.contentHash,
    model,
    message: "当前文字模型生成的路由候选已通过拓扑与防退化校验",
  }, { makeCurrent: true });
  const routeRecord = matchingUnifiedRouteHistoryRecord(registry, expectedRevision, expectedHash);
  if (!routeRecord) throw new Error("当前面板版本缺少可绑定的任务路由历史记录");
  routeRecord.dynamicRoute = publicRouteDocumentRecord(record);
  await writeRegistry(root, registry);
  return {
    applied: true,
    routeDocument: publicRouteDocumentState(registry.routeDocument),
    routeDocumentVersion: publicRouteDocumentRecord(record),
    capabilityTemplate: publicCapabilityTemplateState(registry.capabilityTemplate),
  };
};

export const recordManagedTaskRouteDocumentFailure = async ({ routeRevision = 0, topologyHash = "", model = {}, message = "", errors = [] } = {}) => {
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const topology = compileRouteTopology(registry);
  const expectedRevision = Math.max(0, Number(routeRevision) || 0);
  const expectedHash = String(topologyHash || "").trim().toLowerCase();
  if (Number(topology.revision) !== expectedRevision || String(topology.hash || "").toLowerCase() !== expectedHash) {
    return { recorded: false, message: "Skill 面板已继续变化，过时的路由失败记录没有写入当前版本" };
  }
  const normalizedErrors = (Array.isArray(errors) ? errors : []).map((item) => String(item || "").trim()).filter(Boolean);
  const record = appendRouteDocumentRecord(registry, {
    id: `route-document-rejected:${expectedRevision}:${randomUUID()}`,
    status: "rejected",
    routeRevision: expectedRevision,
    topologyHash: expectedHash,
    model,
    message: String(message || normalizedErrors[0] || "动态任务路由生成失败").trim(),
    errors: normalizedErrors,
  });
  const routeRecord = matchingUnifiedRouteHistoryRecord(registry, expectedRevision, expectedHash);
  if (routeRecord?.dynamicRoute?.status !== "accepted") routeRecord.dynamicRoute = publicRouteDocumentRecord(record);
  await writeRegistry(root, registry);
  return {
    recorded: true,
    routeDocument: publicRouteDocumentState(registry.routeDocument),
    routeDocumentVersion: publicRouteDocumentRecord(record),
    capabilityTemplate: publicCapabilityTemplateState(registry.capabilityTemplate),
  };
};

export const readManagedTaskRouteDocument = async () => {
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const topology = compileRouteTopology(registry);
  const state = normalizeRouteDocumentState(registry.routeDocument);
  const current = state.history.find((entry) => entry.id === state.currentId && entry.status === "accepted") || null;
  if (!current
    || Number(current.routeRevision) !== Number(topology.revision)
    || String(current.topologyHash || "").toLowerCase() !== String(topology.hash || "").toLowerCase()) {
    return { active: false, routeRevision: topology.revision, topologyHash: topology.hash, content: "", current: current ? publicRouteDocumentRecord(current) : null };
  }
  return { active: true, routeRevision: topology.revision, topologyHash: topology.hash, content: current.content, current: publicRouteDocumentRecord(current) };
};

const restoreDynamicRouteForSelectedHistory = (registry, selected, routeRecord) => {
  registry.routeDocument = normalizeRouteDocumentState(registry.routeDocument);
  const selectedRouteId = String(selected?.dynamicRoute?.id || "").trim();
  const source = registry.routeDocument.history.find((entry) => entry.id === selectedRouteId && entry.status === "accepted")
    || [...registry.routeDocument.history].reverse().find((entry) => entry.status === "accepted"
      && Number(entry.routeRevision) === Number(selected?.routeRevision)
      && String(entry.topologyHash || "").toLowerCase() === String(selected?.topologyHash || "").toLowerCase());
  if (!source) {
    if (routeRecord) routeRecord.dynamicRoute = { status: "static", message: "该历史面板没有已通过的动态路由正文，已回退《神思任务路由》" };
    return null;
  }
  const record = appendRouteDocumentRecord(registry, {
    ...source,
    id: `route-document:${registry.routeRevision}:${randomUUID()}`,
    routeRevision: registry.routeRevision,
    topologyHash: routeRecord?.topologyHash || "",
    sourceRecordId: source.id,
    createdAt: Date.now(),
    message: "已随历史面板恢复对应的动态任务路由",
  }, { makeCurrent: true });
  if (routeRecord) routeRecord.dynamicRoute = publicRouteDocumentRecord(record);
  return record;
};

export const restoreManagedCapabilityTemplateVersion = async ({ scopeType = "template", scopeId = "", versionId = "" } = {}) => {
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const effectiveScopeId = scopeType === "template" ? registry.capabilityTemplate.current.template.id : String(scopeId || "");
  const bucket = capabilityTemplateHistoryBucket(registry.capabilityTemplate, scopeType, effectiveScopeId);
  const selected = bucket.find((entry) => entry.id === String(versionId || ""));
  if (!selected) throw new Error("历史版本不存在");
  let candidateBundle = normalizeCapabilityTemplate(registry.capabilityTemplate.current);
  if (scopeType === "template") {
    candidateBundle = applyCapabilityKernelMechanisms(selected.snapshot);
  } else {
    const collection = scopeType === "group" ? candidateBundle.groups : candidateBundle.modules;
    const index = collection.findIndex((node) => node.id === effectiveScopeId);
    if (index < 0) collection.push(structuredClone(selected.snapshot));
    else collection[index] = structuredClone(selected.snapshot);
  }
  const validation = validateCapabilityTemplate(applyCapabilityKernelMechanisms(candidateBundle));
  if (!validation.valid) throw new Error(`该历史版本无法恢复：${validation.errors.join("；")}`);
  const candidateRegistry = {
    ...registry,
    customSlots: selected.routeSnapshot?.customSlots ? structuredClone(selected.routeSnapshot.customSlots) : registry.customSlots,
    customSlotGroups: selected.routeSnapshot?.customSlotGroups ? structuredClone(selected.routeSnapshot.customSlotGroups) : registry.customSlotGroups,
    capabilityTemplate: { ...registry.capabilityTemplate, current: validation.bundle },
  };
  const candidateTopology = compileRouteTopology(candidateRegistry);
  const restoreAdaptationActions = selected.routingAudit?.adaptationActions ?? [];
  const candidateLint = applyAdaptiveNativeFallbackToLint(lintCapabilityTemplateReachability(validation.bundle, {
    fixedSlots: listFixedSkillSlots(),
    userSkills: registry.skills,
  }), restoreAdaptationActions);
  const candidateAudit = capabilityTemplateRoutingAudit({
    bundle: validation.bundle,
    lint: candidateLint,
    routeTopology: candidateTopology,
    fixedSlots: listFixedSkillSlots(),
    userSkills: registry.skills,
    adaptationActions: restoreAdaptationActions,
  });
  if (!candidateAudit.valid) {
    const details = candidateLint.errors.length
      ? candidateLint.errors.join("；")
      : `${candidateAudit.inactiveSlotCount} 个插槽没有可调用 Skill 或官方回退`;
    throw new Error(`该历史版本的任务路由审计未通过：${details}；当前面板和路由保持不变`);
  }
  registry.customSlots = candidateRegistry.customSlots;
  registry.customSlotGroups = candidateRegistry.customSlotGroups;
  registry.capabilityTemplate.current = validation.bundle;
  if (scopeType === "template") {
    const restoredAssetId = registry.capabilityTemplate.current.template.libraryAssetId || "";
    registry.activeCapabilityTemplateAssetId = registry.capabilityAssets.some((asset) => asset.assetType === "template" && asset.id === restoredAssetId)
      ? restoredAssetId : "";
  }
  const localRecord = scopeType === "template" ? null : appendCapabilityTemplateHistory(registry.capabilityTemplate, { scopeType, scopeId: effectiveScopeId, reason: "restored" });
  syncCapabilityAssetsFromCurrent(registry, { scopeType, scopeId: effectiveScopeId });
  bumpRouteRevision(registry, {
    reason: "restored",
    sourceScopeType: scopeType,
    sourceScopeId: effectiveScopeId,
    restoredFromRouteRevision: selected.routeRevision,
    adaptationActions: restoreAdaptationActions,
  });
  const routeRecord = registry.capabilityTemplate.history.template.at(-1);
  if (scopeType === "template") restoreDynamicRouteForSelectedHistory(registry, selected, routeRecord);
  const record = localRecord || routeRecord;
  await writeRegistry(root, registry);
  return {
    capabilityTemplate: publicCapabilityTemplateState(registry.capabilityTemplate),
    restoredVersion: publicTemplateHistoryRecord(record),
    routeVersion: publicTemplateHistoryRecord(routeRecord),
    routeRevision: registry.routeRevision,
    routeTopology: compileRouteTopology(registry),
    lint: candidateLint,
    routingAudit: candidateAudit,
  };
};

export const deleteManagedCapabilityTemplateVersion = async ({ scopeType = "template", scopeId = "", versionId = "" } = {}) => {
  if (!["template", "group", "module"].includes(scopeType)) throw new Error("未知的模板历史范围");
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const effectiveScopeId = scopeType === "template" ? registry.capabilityTemplate.current.template.id : String(scopeId || "");
  const bucket = capabilityTemplateHistoryBucket(registry.capabilityTemplate, scopeType, effectiveScopeId);
  const selected = bucket.find((entry) => entry.id === String(versionId || ""));
  if (!selected) throw new Error("历史版本不存在");
  const retained = bucket.filter((entry) => entry.id !== selected.id);
  if (!retained.length) throw new Error("至少需要保留一个可恢复的历史版本");
  if (scopeType === "template" && Number(selected.routeRevision) > 0 && Number(selected.routeRevision) === Number(registry.routeRevision)) {
    throw new Error("当前正在使用的任务路由版本不能删除");
  }
  if (scopeType === "template") registry.capabilityTemplate.history.template = retained;
  else if (scopeType === "group") registry.capabilityTemplate.history.groups[effectiveScopeId] = retained;
  else registry.capabilityTemplate.history.modules[effectiveScopeId] = retained;
  registry.capabilityTemplate.updatedAt = Date.now();
  await writeRegistry(root, registry);
  const lint = lintCapabilityTemplateReachability(registry.capabilityTemplate.current, {
    fixedSlots: listFixedSkillSlots(),
    userSkills: registry.skills,
  });
  return {
    capabilityTemplate: publicCapabilityTemplateState(registry.capabilityTemplate),
    deletedVersion: publicTemplateHistoryRecord(selected),
    routeRevision: registry.routeRevision,
    routeTopology: compileRouteTopology(registry),
    lint,
  };
};

export const resetManagedCapabilityTemplate = async () => {
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  registry.capabilityTemplate.current = createInitialCapabilityTemplate();
  registry.activeCapabilityTemplateAssetId = "";
  bumpRouteRevision(registry, { reason: "reset", sourceScopeType: "template", sourceScopeId: registry.capabilityTemplate.current.template.id });
  const record = registry.capabilityTemplate.history.template.at(-1);
  await writeRegistry(root, registry);
  return {
    capabilityTemplate: publicCapabilityTemplateState(registry.capabilityTemplate),
    resetVersion: publicTemplateHistoryRecord(record),
    routeRevision: registry.routeRevision,
    routeTopology: compileRouteTopology(registry),
  };
};

const compileRouteTopology = (registry, { fixedSlots = listFixedSkillSlots(), customSlots = null } = {}) => {
  const groups = allSlotGroups(registry).map((group) => group.fixed
    ? { ...group, routePriority: groupPriority(group.id, registry) }
    : publicCustomGroup(group, registry));
  const slots = [
    ...fixedSlots.map((slot) => ({
      id: slot.id,
      name: slot.name,
      parentGroupId: slot.parentGroupId,
      fixed: true,
      developerDefault: slot.developerDefault !== false,
      capabilities: slot.replacementCapabilities,
      routePriority: groupPriority(slot.parentGroupId, registry),
    })),
    ...(customSlots ?? registry.customSlots.map((slot) => publicCustomSlot(slot, registry))).map((slot) => ({
      id: slot.id,
      name: slot.name,
      parentGroupId: slot.parentGroupId,
      fixed: false,
      enabled: slot.enabled === true,
      ready: slot.ready === true,
      developerDefault: slot.developerDefault === true,
      capabilities: slot.capabilities ?? [],
      routePriority: Number(slot.routePriority) || 0,
    })),
  ];
  const payload = {
    schemaVersion: 4,
    revision: Math.max(0, Number(registry.routeRevision) || 0),
    groups,
    slots,
    capabilityTemplate: capabilityTemplateTopology(registry.capabilityTemplate?.current ?? createInitialCapabilityTemplate()),
    capabilityTemplateAuthoritative: true,
    capabilityDescriptorSchemaVersion: CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
    trustedCore: ["intent_and_mode", "task_and_reference_routing", "context_compilation", "authority_resolution", "live_route_compilation", "reference_recall", "continuity_and_format_gate", "structure_and_landing", "memory_commit", "index_projection", "transaction_and_recovery"],
  };
  return { ...payload, hash: hashText(JSON.stringify(payload)) };
};

export const managedRouteTopology = async () => {
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  return compileRouteTopology(registry);
};

export const touchManagedRouteRevision = async ({ shensiRoot = "" } = {}) => {
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  bumpRouteRevision(registry, { reason: "route_refreshed", sourceScopeType: "route", sourceScopeId: "manual-refresh" });
  await writeRegistry(root, registry);
  // A manual template update must compile the current files and bindings, not
  // merely change a number. The catalog pass re-reads active versions,
  // synchronizes bundled snapshots and returns the same topology used by the
  // next task route.
  const catalog = await buildManagedSkillCatalog({ shensiRoot });
  const topology = catalog.routeTopology;
  return {
    routeRevision: catalog.routeRevision,
    routeTopology: topology,
    refreshReport: {
      refreshedAt: new Date().toISOString(),
      topologyHash: topology.hash,
      templateRevision: topology.revision,
      groupCount: topology.groups.length,
      slotCount: topology.slots.length,
      activeSkillCount: [...catalog.builtins, ...catalog.user].filter((skill) => skill.active !== false).length,
      testedPersonalSkillCount: catalog.user.filter((skill) => skill.testStatus === "passed").length,
      capabilityTemplateAuthoritative: topology.capabilityTemplateAuthoritative === true,
    },
  };
};

const slotRoutingSelection = ({ slot, entry, match, registry, organizationGroup = null, organizationRole = "" }) => ({
  id: `user:${entry.id}`,
  requestedRole: "auto",
  source: "custom_slot",
  slotId: slot.id,
  slotName: slot.name,
  slotBindingRole: match.bindingRole ?? "primary",
  secondaryIndex: Number.isInteger(match.secondaryIndex) ? match.secondaryIndex : -1,
  explicitlyActivated: match.explicitlyActivated === true,
  parentGroupId: slot.parentGroupId ?? "",
  groupPath: groupLineage(slot.parentGroupId, registry).map((group) => ({ id: group.id, name: group.name, groupType: group.groupType ?? "parallel" })),
  routePriority: groupPriority(slot.parentGroupId, registry),
  authorizedCapabilities: slot.capabilities,
  capabilityBoundary: slot.capabilityBoundary,
  routeRevision: registry.routeRevision,
  triggerMatch: { score: match.score, reasons: match.reasons },
  organizationGroupId: organizationGroup?.id ?? "",
  organizationRole,
});

const matchCustomSlotsFromRegistry = (registry, {
  text = "",
  workspaceMode = "project",
  activeModule = "manuscript",
  contextDomain = "novel",
  targetDocumentId = "",
  deliverableType = "",
  semanticCapabilities = [],
  semanticCapabilitiesAuthoritative = false,
} = {}) => {
  const semanticSet = new Set(Array.isArray(semanticCapabilities) ? semanticCapabilities : []);
  const matched = registry.customSlots
    .filter((slot) => slot.enabled === true)
    .filter((slot) => (slot.workspaceModes ?? ["general"]).some((mode) => mode === "general" || mode === workspaceMode))
    .map((slot) => {
      const secondaryIndex = slot.slotType === "multi" ? explicitSecondaryIndexForSlot({ text, slotName: slot.name }) : -1;
      const selectedSkillId = secondaryIndex >= 0 ? slot.secondarySkillIds?.[secondaryIndex] || "" : slot.skillId;
      return {
        slot,
        entry: registry.skills.find((entry) => entry.id === selectedSkillId),
        secondaryIndex,
      };
    })
    .filter(({ entry }) => entry?.testStatus === "passed" && entry.disabled !== true)
    .map(({ slot, entry, secondaryIndex }) => {
      const match = semanticCapabilitiesAuthoritative
        ? {
          matched: (slot.capabilities ?? entry.capabilities ?? []).some((capability) => semanticSet.has(capability)),
          score: 0,
          reasons: [],
          semantic: true,
        }
        : matchSkillTrigger(slot, { text, workspaceMode, activeModule, contextDomain, targetDocumentId, deliverableType });
      if (secondaryIndex >= 0) {
        match.matched = true;
        match.score = Math.max(match.score ?? 0, 500);
        match.reasons = [...(match.reasons ?? []), `显式启用“${slot.name}”副插槽 ${secondaryIndex + 1}`];
        match.bindingRole = "secondary";
        match.secondaryIndex = secondaryIndex;
        match.explicitlyActivated = true;
      } else {
        match.bindingRole = "primary";
        match.secondaryIndex = -1;
        match.explicitlyActivated = false;
      }
      return { slot, entry, match };
    })
    .filter(({ match }) => match.matched)
    .sort((left, right) => (groupPriority(right.slot.parentGroupId, registry) + right.match.score) - (groupPriority(left.slot.parentGroupId, registry) + left.match.score)
      || Number(right.entry.localRating ?? 0) - Number(left.entry.localRating ?? 0)
      || Number(left.slot.createdAt ?? 0) - Number(right.slot.createdAt ?? 0));
  const expanded = [];
  for (const candidate of matched) {
    const organizationGroup = [...groupLineage(candidate.slot.parentGroupId, registry)].reverse()
      .find((group) => group.groupType === "organization" && group.leaderSlotId);
    if (organizationGroup && candidate.slot.id !== organizationGroup.leaderSlotId) {
      const leaderSlot = registry.customSlots.find((slot) => slot.id === organizationGroup.leaderSlotId && slot.enabled === true);
      const leaderEntry = leaderSlot ? registry.skills.find((entry) => entry.id === leaderSlot.skillId && entry.testStatus === "passed" && entry.disabled !== true) : null;
      if (leaderSlot && leaderEntry && !expanded.some(({ slot }) => slot.id === leaderSlot.id)) {
        expanded.push({
          slot: leaderSlot,
          entry: leaderEntry,
          match: { score: candidate.match.score, reasons: [`组织组“${organizationGroup.name}”的下位插槽已命中`] },
          organizationGroup,
          organizationRole: "leader",
        });
      }
    }
    if (!expanded.some(({ slot }) => slot.id === candidate.slot.id)) expanded.push({
      ...candidate,
      organizationGroup,
      organizationRole: organizationGroup ? candidate.slot.id === organizationGroup.leaderSlotId ? "leader" : "member" : "",
    });
  }
  return expanded.slice(0, 12).map(({ slot, entry, match, organizationGroup, organizationRole }) => slotRoutingSelection({
    slot,
    entry,
    match,
    registry,
    organizationGroup,
    organizationRole,
  }));
};

export const resolveManagedCustomSlotRouting = async (context = {}) => {
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const routeTopology = compileRouteTopology(registry);
  const templateRouting = resolveCapabilityTemplateRouting(registry.capabilityTemplate.current, {
    ...context,
    requiredCapabilities: context.requiredCapabilities ?? [],
    semanticCapabilities: context.semanticCapabilities ?? [],
    semanticCapabilitiesAuthoritative: context.semanticCapabilitiesAuthoritative === true,
    fixedSlots: listFixedSkillSlots(),
    userSkills: registry.skills,
    legacyConfiguredSelections: context.legacyConfiguredSelections ?? [],
    templateRevision: routeTopology.revision,
    templateHash: routeTopology.hash,
  });
  const customSelections = matchCustomSlotsFromRegistry(registry, context);
  return {
    selections: [
      ...templateRouting.selections,
      ...customSelections,
    ],
    activatedSelections: [
      ...(templateRouting.activatedSelections ?? templateRouting.selections),
      ...customSelections,
    ],
    routeTopology,
    compiledCapabilityPlan: templateRouting.compiledCapabilityPlan,
    templateDiagnostics: templateRouting.diagnostics,
  };
};

export const matchingManagedCustomSlots = async (context = {}) => (await resolveManagedCustomSlotRouting(context)).selections;

export const setManagedSkillRating = async ({ id, rating } = {}) => {
  const { root, registry, entry } = await findManagedEntry(id);
  const value = Number(rating);
  if (!Number.isInteger(value) || value < 0 || value > 5) throw new Error("评分必须为 0-5 的整数");
  entry.localRating = value;
  await writeRegistry(root, registry);
  return publicSkill(entry);
};

export const setManagedSkillDisabled = async ({ id, disabled } = {}) => {
  const { root, registry, entry } = await findManagedEntry(id);
  entry.disabled = disabled === true;
  bumpRouteRevision(registry, { reason: "skill_changed", sourceScopeType: "skill", sourceScopeId: entry.id });
  await writeRegistry(root, registry);
  return { skill: publicSkill(entry), routeRevision: registry.routeRevision };
};

const stageManagedSkillTrash = async ({ root, registry, entry, capabilityAsset = null } = {}) => {
  const deletedAt = Date.now();
  const trashId = `skill-trash-${deletedAt}-${randomUUID()}`;
  const archiveFolder = trashId;
  const sourcePath = resolve(root, USER_DIRECTORY, entry.id);
  const archivePath = skillTrashPath(root, archiveFolder);
  if (!(await stat(sourcePath).catch(() => null))) throw new Error("Skill 本地包不存在，无法安全移入回收站");
  await rename(sourcePath, archivePath);
  registry.skills = registry.skills.filter((item) => item !== entry);
  let routeChanged = false;
  for (const slot of registry.customSlots) {
    const primaryMatched = slot.skillId === entry.id;
    const secondaryMatched = (slot.secondarySkillIds ?? []).includes(entry.id);
    if (!primaryMatched && !secondaryMatched) continue;
    if (primaryMatched) {
      slot.skillId = "";
      slot.enabled = Boolean(slot.developerSkillId);
    }
    slot.secondarySkillIds = (slot.secondarySkillIds ?? []).map((skillId) => skillId === entry.id ? "" : skillId);
    slot.updatedAt = deletedAt;
    routeChanged = true;
  }
  const runtimeSkillId = `user:${entry.id}`;
  const templateContainsSkill = registry.capabilityTemplate.current.modules.some((module) => module.slots.some((slot) => slot.skillId === runtimeSkillId));
  if (templateContainsSkill) {
    const next = normalizeCapabilityTemplate(registry.capabilityTemplate.current);
    for (const module of next.modules) {
      for (const slot of module.slots) {
        if (slot.skillId !== runtimeSkillId) continue;
        slot.skillId = "";
        slot.compositeChildId = "";
      }
    }
    const validation = validateCapabilityTemplate(applyCapabilityKernelMechanisms(next));
    if (!validation.valid) {
      await rename(archivePath, sourcePath).catch(() => {});
      throw new Error(`Skill 删除前的面板解绑失败：${validation.errors.join("；")}`);
    }
    registry.capabilityTemplate.current = validation.bundle;
    registry.capabilityTemplate = normalizeCapabilityTemplateState(registry.capabilityTemplate, {
      customSlots: registry.customSlots,
      customSlotGroups: registry.customSlotGroups,
    });
    routeChanged = true;
  }
  const trashEntry = {
    trashId,
    skillId: entry.id,
    title: entry.name,
    origin: entry.origin,
    sourceLabel: entry.sourceLabel,
    archiveFolder,
    entry,
    capabilityAsset: capabilityAsset ? structuredClone(capabilityAsset) : null,
    deletedAt,
    deletedAtIso: new Date(deletedAt).toISOString(),
    expiresAtIso: new Date(deletedAt + SKILL_TRASH_RETENTION_MS).toISOString(),
  };
  registry.skillTrash = [trashEntry, ...(registry.skillTrash ?? [])];
  if (routeChanged) bumpRouteRevision(registry, { reason: "skill_changed", sourceScopeType: "skill", sourceScopeId: entry.id });
  return { trashEntry, sourcePath, archivePath };
};

export const deleteManagedSkill = async ({ id } = {}) => {
  const { root, registry, entry } = await findManagedEntry(id);
  await pruneExpiredSkillTrash(root, registry);
  const staged = await stageManagedSkillTrash({ root, registry, entry });
  try {
    await writeRegistry(root, registry);
  } catch (error) {
    await rename(staged.archivePath, staged.sourcePath).catch(() => {});
    throw error;
  }
  return { id: `user:${entry.id}`, deleted: true, trash: publicSkillTrashEntry(staged.trashEntry), routeRevision: registry.routeRevision };
};

export const exportManagedSkill = async ({ id, version = "" } = {}) => {
  const { root, entry } = await findManagedEntry(id);
  const loaded = await loadEntryVersion(root, entry, version || entry.activeVersion);
  await ensureStandardSkillPackage(root, entry);
  const entries = await collectSkillPackageEntries(versionRoot(root, entry.id, loaded.versionRecord.version));
  const bytes = zipStore(entries, new Date(loaded.versionRecord.installedAt || Date.now()));
  return {
    fileName: `${entry.id}-${loaded.versionRecord.version}.skill`,
    mimeType: "application/vnd.shensi.skill+zip",
    bytes,
    content: loaded.content,
  };
};

const applyManagedSkillVersion = (entry, loaded) => {
  const { metadata, versionRecord } = loaded;
  Object.assign(entry, {
    name: metadata.name,
    activeVersion: metadata.version,
    author: metadata.author,
    description: metadata.description,
    prototypeId: metadata.prototypeId,
    prototypeName: metadata.prototypeName,
    prototypeFingerprint: metadata.prototypeFingerprint,
    derivativeCopy: metadata.derivativeCopy === true,
    upstreamId: metadata.upstreamId || entry.upstreamId || "",
    upstreamVersion: metadata.upstreamVersion || entry.upstreamVersion || "",
    changeSummary: metadata.changeSummary,
    capabilityBoundary: metadata.capabilityBoundary,
    origin: normalizedOrigin(versionRecord.source),
    source: metadata.source,
    trustLevel: normalizedTrustLevel(versionRecord.trustLevel, versionRecord.source),
    sourceType: versionRecord.sourceType || inferredSourceType(metadata.source, versionRecord.source),
    capabilities: metadata.capabilities,
    declaredCapabilities: metadata.declaredCapabilities,
    role: metadata.role,
    workspaceModes: metadata.workspaceModes,
    artifactTypes: metadata.artifactTypes,
    inputRequirements: metadata.inputRequirements,
    outputContract: metadata.outputContract,
    stages: metadata.stages,
    slots: metadata.slots,
    conflictPolicy: metadata.conflictPolicy,
    fallback: metadata.fallback,
    triggerKeywords: metadata.triggerKeywords,
    triggerConditions: metadata.triggerConditions,
    compositeDefinition: normalizeStoredCompositeDefinition(versionRecord.compositeDefinition),
    hash: versionRecord.hash,
    lastTestedAt: versionRecord.lastTestedAt || 0,
    testStatus: versionRecord.testStatus || "untested",
    testSummary: versionRecord.testSummary || "恢复的版本尚未测试",
    sandboxVerified: versionRecord.sandboxVerified === true,
    sandboxVerifiedVersion: versionRecord.sandboxVerified === true ? versionRecord.version : "",
  });
};

export const restoreManagedSkillVersion = async ({ id, version } = {}) => {
  const { root, registry, entry } = await findManagedEntry(id);
  const loaded = await loadEntryVersion(root, entry, String(version || ""));
  applyManagedSkillVersion(entry, loaded);
  bumpRouteRevision(registry, { reason: "skill_changed", sourceScopeType: "skill", sourceScopeId: entry.id });
  await writeRegistry(root, registry);
  return { skill: publicSkill(entry), routeRevision: registry.routeRevision };
};

export const deleteManagedSkillVersion = async ({ id, version } = {}) => {
  const { root, registry, entry } = await findManagedEntry(id);
  const selectedVersion = String(version || "");
  const selected = (entry.versions ?? []).find((candidate) => String(candidate.version) === selectedVersion);
  if (!selected) throw new Error("Skill 历史版本不存在");
  if ((entry.versions ?? []).length <= 1) throw new Error("至少保留一个本地版本；如需移除，请删除整个 Skill");
  const remaining = (entry.versions ?? []).filter((candidate) => candidate !== selected);
  const activeChanged = String(entry.activeVersion) === selectedVersion;
  const fallback = activeChanged
    ? [...remaining].sort((left, right) => (Number(right.installedAt) || 0) - (Number(left.installedAt) || 0)
      || String(right.version).localeCompare(String(left.version), undefined, { numeric: true }))[0]
    : null;
  const fallbackLoaded = fallback ? await loadEntryVersion(root, entry, fallback.version) : null;
  const sourcePath = versionRoot(root, entry.id, selected.version);
  if (!(await stat(sourcePath).catch(() => null))) throw new Error("Skill 历史版本文件不存在");
  const stagingRoot = resolve(root, ".version-delete-staging");
  const stagedPath = resolve(stagingRoot, `${entry.id}-${randomUUID()}`);
  if (!isInside(stagedPath, stagingRoot)) throw new Error("Skill 历史版本删除路径越界");
  await mkdir(stagingRoot, { recursive: true });
  await rename(sourcePath, stagedPath);
  entry.versions = remaining;
  if (fallbackLoaded) applyManagedSkillVersion(entry, fallbackLoaded);
  if (activeChanged) bumpRouteRevision(registry, { reason: "skill_changed", sourceScopeType: "skill", sourceScopeId: entry.id });
  try {
    await writeRegistry(root, registry);
  } catch (error) {
    await rename(stagedPath, sourcePath).catch(() => {});
    throw error;
  }
  const storageCleanupPending = !(await rm(stagedPath, { recursive: true, force: true }).then(() => true).catch(() => false));
  return {
    skill: publicSkill(entry),
    deletedVersion: selectedVersion,
    activeChanged,
    storageCleanupPending,
    routeRevision: registry.routeRevision,
  };
};

export const restoreManagedSkillTrash = async ({ trashId } = {}) => {
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  await pruneExpiredSkillTrash(root, registry);
  const item = (registry.skillTrash ?? []).find((entry) => entry.trashId === String(trashId || ""));
  if (!item) throw new Error("Skill 回收项不存在或已过期");
  if (registry.skills.some((entry) => entry.id === item.skillId)) throw new Error("活动库中已有同 ID Skill，无法恢复");
  const archivePath = skillTrashPath(root, item.archiveFolder);
  if (!(await stat(archivePath).catch(() => null))) throw new Error("Skill 回收文件已经不存在");
  const target = resolve(root, USER_DIRECTORY, item.skillId);
  if (!isInside(target, resolve(root, USER_DIRECTORY))) throw new Error("Skill 恢复路径越界");
  if (await stat(target).catch(() => null)) throw new Error("Skill 原位置已被占用，无法恢复");
  let restoredAsset = null;
  let restoredTemplate = null;
  if (item.capabilityAsset) {
    if ((registry.capabilityAssets ?? []).some((asset) => asset.id === item.capabilityAsset.id)) throw new Error("活动库中已有同 ID 复合 Skill 结构，无法恢复");
    const record = capabilityAssetActiveRecord(item.capabilityAsset);
    if (!record) throw new Error("复合 Skill 的结构快照已经损坏，无法恢复");
    const next = normalizeCapabilityTemplate(registry.capabilityTemplate.current);
    const incomingIds = new Set([...record.payload.bundle.groups.map((group) => group.id), ...record.payload.bundle.modules.map((module) => module.id)]);
    if (next.groups.some((group) => incomingIds.has(group.id)) || next.modules.some((module) => incomingIds.has(module.id))) throw new Error("当前面板库已有同 ID 模块或模组，无法恢复复合 Skill");
    next.groups.push(...record.payload.bundle.groups.map((group) => structuredClone(group)));
    next.modules.push(...record.payload.bundle.modules.map((module) => structuredClone(module)));
    const validation = validateCapabilityTemplate(next);
    if (!validation.valid) throw new Error(`复合 Skill 结构恢复失败：${validation.errors.join("；")}`);
    restoredTemplate = validation.bundle;
    restoredAsset = normalizeStoredCapabilityAsset(item.capabilityAsset);
  }
  await rename(archivePath, target);
  registry.skills.push(item.entry);
  if (restoredAsset) {
    registry.capabilityAssets = [...(registry.capabilityAssets ?? []), restoredAsset];
    registry.capabilityTemplate.current = restoredTemplate;
    registry.capabilityTemplate = normalizeCapabilityTemplateState(registry.capabilityTemplate, {
      customSlots: registry.customSlots,
      customSlotGroups: registry.customSlotGroups,
    });
  }
  registry.skillTrash = registry.skillTrash.filter((entry) => entry !== item);
  bumpRouteRevision(registry, { reason: "skill_changed", sourceScopeType: "skill", sourceScopeId: item.skillId });
  try {
    await writeRegistry(root, registry);
  } catch (error) {
    await rename(target, archivePath).catch(() => {});
    throw error;
  }
  return { skill: publicSkill(item.entry), restored: true, routeRevision: registry.routeRevision };
};

export const permanentlyDeleteManagedSkillTrash = async ({ trashId } = {}) => {
  const root = await ensureSkillStore();
  const registry = await readRegistry(root);
  const item = (registry.skillTrash ?? []).find((entry) => entry.trashId === String(trashId || ""));
  if (!item) throw new Error("Skill 回收项不存在或已过期");
  await rm(skillTrashPath(root, item.archiveFolder), { recursive: true, force: true });
  registry.skillTrash = registry.skillTrash.filter((entry) => entry !== item);
  await writeRegistry(root, registry);
  return { deleted: true, trashId: item.trashId, recoveryHint: publicSkillTrashEntry(item).recoveryHint };
};

export const managedSkillTree = async ({ shensiRoot = "" } = {}) => {
  const catalog = await listManagedSkills({ shensiRoot });
  if (!catalog.user.length) return [];
  const byCategory = new Map();
  for (const skill of catalog.user) {
    if (skill.testStatus !== "passed") continue;
    const category = skill.capabilities.some((item) => ["creative_guidance", "novel_guidance", "public_account_guidance", "short_fiction_guidance", "short_video_guidance", "prompt_guidance"].includes(item)) ? "创作引导"
      : skill.capabilities.includes("theory_advisor") ? "理论顾问"
      : skill.capabilities.some((item) => ["effect_reviewer", "genre_reviewer", "format_extension"].includes(item)) ? "自检与审查"
      : skill.capabilities.includes("repair_writer") ? "返修主笔"
      : skill.capabilities[0]?.includes("setting") ? "设定主笔"
      : skill.capabilities.includes("story_planner") ? "故事规划"
      : skill.capabilities[0]?.includes("novel") ? "小说主笔"
      : skill.capabilities.includes("custom_writer") ? "自定义主笔"
      : skill.workspaceModes.includes("general") ? "通用创作"
      : skill.workspaceModes.includes("notebook") ? "笔记创作" : "其他 Skill";
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push({
      type: "skill",
      ...skill,
      relativePath: skill.id,
      fileName: `${skill.skillId}.md`,
    });
  }
  return [...byCategory].map(([name, children]) => ({
    type: "folder",
    id: `managed:${name}`,
    name,
    relativePath: `managed/${name}`,
    children,
  }));
};

export const loadManagedSkillSelections = async (selections = []) => {
  const loaded = [];
  for (const selection of (Array.isArray(selections) ? selections : []).slice(0, 24)) {
    const id = typeof selection === "string" ? selection : selection?.id || selection?.relativePath;
    if (!String(id).startsWith("user:")) continue;
    try {
      const skill = await loadManagedSkill({ id, includeContent: true });
      if (skill.testStatus !== "passed" || skill.disabled === true) continue;
      loaded.push({
        ...skill,
        content: compositeSkillRuntimeBody(skill, typeof selection === "object" ? selection : {}),
        requestedRole: typeof selection === "object" ? selection.requestedRole : "",
        activationSource: typeof selection === "object" ? selection.source ?? "explicit" : "explicit",
        selectionAuthorizedCapabilities: typeof selection === "object" && Array.isArray(selection.authorizedCapabilities)
          ? selection.authorizedCapabilities : null,
        slotId: typeof selection === "object" ? selection.slotId ?? "" : "",
        slotName: typeof selection === "object" ? selection.slotName ?? "" : "",
        parentGroupId: typeof selection === "object" ? selection.parentGroupId ?? "" : "",
        groupPath: typeof selection === "object" && Array.isArray(selection.groupPath) ? selection.groupPath : [],
        routePriority: typeof selection === "object" ? Number(selection.routePriority) || 0 : 0,
        slotCapabilityBoundary: typeof selection === "object" ? selection.capabilityBoundary ?? "" : "",
        routeRevision: typeof selection === "object" ? Number(selection.routeRevision) || 0 : 0,
        triggerMatch: typeof selection === "object" ? selection.triggerMatch ?? null : null,
        organizationGroupId: typeof selection === "object" ? selection.organizationGroupId ?? "" : "",
        organizationRole: typeof selection === "object" ? selection.organizationRole ?? "" : "",
        relationScopeId: typeof selection === "object" ? selection.relationScopeId ?? "" : "",
        relationType: typeof selection === "object" ? selection.relationType ?? "parallel" : "parallel",
        relationRole: typeof selection === "object" ? selection.relationRole ?? "peer" : "peer",
        relationScopes: typeof selection === "object" && Array.isArray(selection.relationScopes) ? selection.relationScopes : [],
        exclusiveKey: typeof selection === "object" ? selection.exclusiveKey ?? "" : "",
        stackKey: typeof selection === "object" ? selection.stackKey ?? "" : "",
        activationPolicy: typeof selection === "object" ? selection.activationPolicy ?? null : null,
        capabilityDescriptors: typeof selection === "object" && Array.isArray(selection.capabilityDescriptors) ? selection.capabilityDescriptors : [],
        implementationStatus: typeof selection === "object" ? selection.implementationStatus ?? "template_implementation" : "explicit",
        fallbackReason: typeof selection === "object" ? selection.fallbackReason ?? "" : "",
        securityBlockedCapabilities: [],
      });
    } catch {}
  }
  return loaded;
};
