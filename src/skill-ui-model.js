const SKILL_MODE_LABELS = Object.freeze({
  project: "作品模式",
  notebook: "笔记模式",
  general: "通用模式",
});

const OFFICIAL_MARKETPLACE_SORT_FALLBACK = Object.freeze({
  "official:book-deconstruction": { popularity: 980, publishedAt: Date.UTC(2026, 5, 18) },
  "official:style-distillation": { popularity: 760, publishedAt: Date.UTC(2026, 6, 16) },
});

const normalizedSkillKey = (value = "") => String(value || "").trim().replace(/^user:/, "");

const skillKeys = (skill = {}) => new Set([
  skill.id,
  skill.skillId,
  skill.sourceId,
  skill.remoteArtifactId,
].map(normalizedSkillKey).filter(Boolean));

const normalizedKeySet = (values = []) => new Set([...values].map(normalizedSkillKey).filter(Boolean));

export const skillModeLabel = (skill = {}) => (skill.workspaceModes?.length ? skill.workspaceModes : ["general"])
  .map((mode) => SKILL_MODE_LABELS[mode] || mode)
  .join(" / ");

export const skillOriginLabel = (skill = {}) => skill.sourceType === "github"
  ? "GitHub 下载"
  : skill.origin === "created"
    ? "自定义"
    : skill.origin === "downloaded"
      ? "广场"
      : "本地";

export const marketplaceRatingStars = (rating = 0) => {
  const normalized = Math.max(0, Math.min(5, Number(rating) || 0));
  return `${"★".repeat(normalized)}${"☆".repeat(5 - normalized)}`;
};

export const marketplaceRatingLabel = (rating = 0) => Number(rating) > 0 ? `你的评分 ${Number(rating)}/5` : "未评分";

export const normalizedMarketplaceSearch = (value = "") => String(value).trim().toLocaleLowerCase("zh-CN");

export const marketplacePublicationKeys = (item = {}) => [item.id, item.skillId, item.sourceId, item.remoteArtifactId]
  .map((value) => String(value || "").trim())
  .filter(Boolean);

export const marketplaceItemPublishedByUser = (item = {}, submissions = []) => {
  if (item.publishedByUser === true) return true;
  const publishedKeys = normalizedKeySet((Array.isArray(submissions) ? submissions : []).flatMap(marketplacePublicationKeys));
  return marketplacePublicationKeys(item).map(normalizedSkillKey).some((key) => publishedKeys.has(key));
};

export const capabilityAssetTypeLabel = (value = "skill") => value === "template" ? "面板" : value === "group" ? "模组" : value === "module" ? "模块" : "Skill";

export const capabilityAssetIcon = (value = "skill") => value === "template" || value === "group" ? "\uE8F1" : "\uE943";

export const marketplacePublishedAt = (skill = {}) => {
  const value = Number(skill.publishedAt);
  if (Number.isFinite(value) && value > 0) return value;
  const parsed = Date.parse(String(skill.publishedAt || ""));
  if (Number.isFinite(parsed)) return parsed;
  return Number(OFFICIAL_MARKETPLACE_SORT_FALLBACK[skill.id]?.publishedAt) || 0;
};

export const marketplaceHotScore = (skill = {}) => Number(skill.popularity)
  || Number(skill.downloadCount)
  || (Number(skill.ratingAverage) || 0) * (Number(skill.ratingCount) || 0)
  || Number(OFFICIAL_MARKETPLACE_SORT_FALLBACK[skill.id]?.popularity)
  || 0;

export const sortedMarketplaceItems = (items = [], view = "hot") => [...items].sort((left, right) => {
  if (view === "latest") return marketplacePublishedAt(right) - marketplacePublishedAt(left)
    || marketplaceHotScore(right) - marketplaceHotScore(left)
    || left.name.localeCompare(right.name, "zh-CN");
  return marketplaceHotScore(right) - marketplaceHotScore(left)
    || marketplacePublishedAt(right) - marketplacePublishedAt(left)
    || left.name.localeCompare(right.name, "zh-CN");
});

export const templateSkillIds = (bundle = {}) => {
  const modules = Array.isArray(bundle.modules) ? bundle.modules : [];
  const groups = Array.isArray(bundle.groups) ? bundle.groups : [];
  const root = bundle.template ?? bundle;
  const moduleById = new Map(modules.map((module) => [module.id, module]));
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const hasPlacementModel = Boolean(bundle.template) && Array.isArray(root.items);
  const reachableModules = new Set();
  const visitedGroups = new Set();
  const queue = Array.isArray(root.items) ? [...root.items] : [];

  while (queue.length) {
    const placement = queue.shift();
    if (placement?.targetType === "module" && moduleById.has(placement.targetId)) {
      reachableModules.add(placement.targetId);
      continue;
    }
    if (placement?.targetType !== "group" || visitedGroups.has(placement.targetId)) continue;
    visitedGroups.add(placement.targetId);
    const group = groupById.get(placement.targetId);
    if (group?.items?.length) queue.push(...group.items);
  }

  const activeModules = hasPlacementModel
    ? modules.filter((module) => reachableModules.has(module.id))
    : modules;
  return new Set(activeModules
    .flatMap((module) => module.slots ?? [])
    .flatMap((slot) => [slot.skillId, slot.compositeChildId])
    .map(normalizedSkillKey)
    .filter(Boolean));
};

export const publishedSkillIds = (submissions = []) => normalizedKeySet((Array.isArray(submissions) ? submissions : [])
  .filter((item) => (
    (item.assetType || "skill") === "skill"
    && String(item.status || item.publicationStatus || "published").toLowerCase() !== "yanked"
  ))
  .flatMap(marketplacePublicationKeys));

export const skillAuthoringState = (skill = {}, { configuredIds = new Set(), sharedIds = new Set() } = {}) => {
  const keys = skillKeys(skill);
  const matches = (values) => [...keys].some((key) => values.has(key));
  const tested = skill.readOnly === true || skill.testStatus === "passed";
  const configured = matches(normalizedKeySet(configuredIds));
  const shared = skill.trustLevel === "official" && !skill.prototypeId || matches(normalizedKeySet(sharedIds));
  const next = !tested ? "test" : !configured ? "adopt" : !shared ? "publish" : "maintain";
  return { saved: true, tested, configured, shared, next };
};

export const skillAuthoringSummary = ({ skills = [], template = {}, submissions = [] } = {}) => {
  const configuredIds = templateSkillIds(template);
  const sharedIds = publishedSkillIds(submissions);
  const states = skills.map((skill) => ({ skill, ...skillAuthoringState(skill, { configuredIds, sharedIds }) }));
  return {
    total: states.length,
    tested: states.filter((item) => item.tested).length,
    configured: states.filter((item) => item.configured).length,
    shared: states.filter((item) => item.shared).length,
    states,
  };
};
