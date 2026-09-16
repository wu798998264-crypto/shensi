import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { extractSkillDraft } from "../skill-contract.js";
import { unzipSelectedEntries } from "./document-extraction.mjs";
import { zipStore } from "./docx-export.mjs";

const MAX_GITHUB_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_GITHUB_SELECTED_BYTES = 12 * 1024 * 1024;
const MAX_GITHUB_FILES = 800;
const MAX_GITHUB_SNAPSHOTS = 5;
const GITHUB_SNAPSHOT_TTL_MS = 15 * 60_000;
const GITHUB_HOST = "github.com";
const SAFE_SUPPORT_FILE = /\.(?:md|markdown|txt|json|ya?ml|csv|png|jpe?g|webp|gif|svg)$/iu;
const SKILL_FILE = /(?:^|\/)skill\.md$/iu;
const BLOCKED_PATH = /(?:^|\/)(?:\.git|node_modules|dist|release|output|artifacts|test-results)(?:\/|$)/iu;

const snapshots = new Map();
const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cleanLine = (value = "", fallback = "") => String(value || fallback)
  .replace(/[\r\n\t]+/gu, " ")
  .replace(/\s{2,}/gu, " ")
  .trim();
const normalizedPath = (value = "") => String(value || "")
  .replaceAll("\\", "/")
  .replace(/^\/+|\/+$/gu, "")
  .replace(/\/{2,}/gu, "/");
const readablePathName = (value = "", fallback = "Skill") => cleanLine(String(value || "")
  .replace(/\.(?:md|markdown)$/iu, "")
  .replace(/[-_]+/gu, " "), fallback);
const fileSegment = (value = "", fallback = "skill") => String(value || fallback)
  .normalize("NFKC")
  .replace(/[^\p{L}\p{N}._-]+/gu, "-")
  .replace(/^-+|-+$/gu, "")
  .slice(0, 64) || fallback;
const idSegment = (value = "", fallback = "skill") => String(value || fallback)
  .toLowerCase()
  .replace(/[^a-z0-9._-]+/gu, "-")
  .replace(/^-+|-+$/gu, "")
  .slice(0, 36) || fallback;
const unique = (values = []) => [...new Set(values.filter(Boolean))];
const safeList = (values = []) => unique(values.map((value) => cleanLine(value)).filter(Boolean));
const yamlScalar = (value = "") => JSON.stringify(cleanLine(value));
const yamlArray = (name, values) => `${name}:\n${safeList(values).map((value) => `  - ${yamlScalar(value)}`).join("\n")}`;

const skillId = ({ owner, repository, name, sourcePath, usedIds }) => {
  const base = `github.${idSegment(owner, "author")}.${idSegment(repository, "repository")}`;
  const suffix = idSegment(name, "skill");
  const digest = createHash("sha1").update(`${sourcePath}:${name}`).digest("hex").slice(0, 8);
  let candidate = `${base}.${suffix}`.slice(0, 70).replace(/[.-]+$/gu, "");
  candidate = `${candidate}.${digest}`.slice(0, 80);
  while (usedIds.has(candidate)) candidate = `${candidate.slice(0, 70)}.${randomUUID().slice(0, 8)}`;
  usedIds.add(candidate);
  return candidate;
};

const normalizedSkillSource = ({ source, owner, repository, sourcePath, sourceUrl, usedIds, usedNames, fallbackName }) => {
  const extracted = extractSkillDraft(String(source || ""));
  const draft = extracted.draft;
  const requestedName = cleanLine(draft.name, fallbackName || readablePathName(posix.basename(posix.dirname(sourcePath)), repository));
  const parentName = readablePathName(posix.basename(posix.dirname(sourcePath)), "子 Skill");
  let name = requestedName;
  if (usedNames?.has(name.toLocaleLowerCase("zh-CN"))) name = `${requestedName} · ${parentName}`;
  if (usedNames?.has(name.toLocaleLowerCase("zh-CN"))) name = `${name} · ${createHash("sha1").update(sourcePath).digest("hex").slice(0, 6)}`;
  usedNames?.add(name.toLocaleLowerCase("zh-CN"));
  const id = skillId({ owner, repository, name, sourcePath, usedIds });
  const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(String(draft.version || "")) && draft.version !== "0.0.0"
    ? draft.version : "1.0.0";
  const capabilities = safeList(draft.capabilities?.length ? draft.capabilities : ["auxiliary_advisor"]);
  const workspaceModes = safeList(draft.workspaceModes?.length ? draft.workspaceModes : ["general"]);
  const body = String(draft.body || source || "").replace(/^---\s*[\s\S]*?---\s*/u, "").trim();
  const normalized = [
    "---",
    "schema_version: 2",
    `id: ${yamlScalar(id)}`,
    `name: ${yamlScalar(name)}`,
    `version: ${yamlScalar(version)}`,
    `author: ${yamlScalar(cleanLine(draft.author, owner))}`,
    `description: ${yamlScalar(cleanLine(draft.description, `${name}，从 GitHub 导入。`))}`,
    `source: ${yamlScalar(sourceUrl)}`,
    `capability_boundary: ${yamlScalar(cleanLine(draft.capabilityBoundary, "只在用户明确授权的 Skill 插槽或引用范围内提供候选内容，不接管任务路由、资料权限或文件落盘。"))}`,
    yamlArray("capabilities", capabilities),
    yamlArray("workspace_modes", workspaceModes),
    yamlArray("trigger_keywords", draft.triggerKeywords || []),
    yamlArray("trigger_conditions", draft.triggerConditions || []),
    "---",
    body || `# ${name}\n\n按当前插槽授权范围使用本 Skill。`,
  ].join("\n");
  return {
    id,
    name,
    version,
    description: cleanLine(draft.description, `${name}，从 GitHub 导入。`),
    capabilities,
    workspaceModes,
    body,
    sourcePath,
    source: normalized,
  };
};

const capabilityFamily = (capabilities = []) => {
  const values = new Set(capabilities);
  if (["creative_guidance", "novel_guidance", "short_drama_guidance", "public_account_guidance", "short_fiction_guidance", "short_video_guidance", "prompt_guidance"].some((item) => values.has(item))) return "创作引导能力";
  if (["story_planner", "setting_planner"].some((item) => values.has(item))) return "规划与设定能力";
  if (["novel_prose_writer", "original_script_writer", "adaptation_writer", "public_account_writer", "short_fiction_writer", "short_video_script_writer", "custom_writer"].some((item) => values.has(item))) return "主笔写作能力";
  if (["visual_prompt_writer", "prompt_writer", "article_illustration_planner", "novel_cover_designer"].some((item) => values.has(item))) return "视觉提示词能力";
  if (["effect_reviewer", "strong_story_reviewer", "regular_progress_reviewer", "genre_reviewer", "repair_writer", "format_extension"].some((item) => values.has(item))) return "自检与修复能力";
  if (["memory_advisor", "experience_advisor", "experience_observer"].some((item) => values.has(item))) return "记忆与经验能力";
  return "辅助参考能力";
};

export const parseGithubSkillUrl = (value = "") => {
  let url;
  try { url = new URL(String(value || "").trim()); } catch { throw new Error("请输入有效的 GitHub 链接"); }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== GITHUB_HOST) throw new Error("只支持 https://github.com 的公开仓库链接");
  const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  const [owner, rawRepository, route, rawRef, ...rest] = segments;
  const repository = String(rawRepository || "").replace(/\.git$/iu, "");
  if (!/^[A-Za-z0-9_.-]{1,100}$/u.test(owner || "") || !/^[A-Za-z0-9_.-]{1,100}$/u.test(repository)) throw new Error("GitHub 链接缺少有效的仓库作者或仓库名称");
  if (route && !["tree", "blob"].includes(route)) throw new Error("请粘贴仓库首页、tree 子目录或 SKILL.md 文件链接");
  const ref = route ? cleanLine(rawRef) : cleanLine(url.searchParams.get("ref"));
  let subPath = route ? normalizedPath(rest.join("/")) : "";
  if (route === "blob" && /(?:^|\/)skill\.md$/iu.test(subPath)) subPath = normalizedPath(posix.dirname(subPath));
  if (subPath && subPath.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("GitHub 子目录路径无效");
  return {
    owner,
    repository,
    ref,
    subPath: subPath === "." ? "" : subPath,
    sourceUrl: `https://github.com/${owner}/${repository}${ref ? `/tree/${ref}${subPath ? `/${subPath}` : ""}` : ""}`,
  };
};

const readLimitedResponse = async (response, limit) => {
  const declared = Number(response.headers.get("content-length")) || 0;
  if (declared > limit) throw new Error(`GitHub 仓库压缩包超过 ${Math.floor(limit / 1024 / 1024)} MB，已停止下载`);
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error("GitHub 仓库压缩包过大，已停止下载");
    return bytes;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error("GitHub 仓库压缩包过大，已停止下载");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
};

const githubJson = async (url, fetchImpl) => {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Shensi-Creative-Engine" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(response.status === 404 ? "GitHub 仓库、分支或目录不存在，或者仓库不是公开仓库" : `GitHub 元数据读取失败（${response.status}）`);
  return response.json();
};

const selectedArchiveEntries = (archiveBytes, link) => {
  const rawEntries = unzipSelectedEntries(archiveBytes, (name) => {
    const path = normalizedPath(name);
    if (!path || path.split("/").some((part) => !part || part === "." || part === "..") || BLOCKED_PATH.test(path)) return false;
    const repositoryPath = path.split("/").slice(1).join("/");
    if (link.subPath && repositoryPath !== link.subPath && !repositoryPath.startsWith(`${link.subPath}/`)) return false;
    return SKILL_FILE.test(path) || SAFE_SUPPORT_FILE.test(path);
  });
  const entries = rawEntries.map((entry) => {
    const repositoryPath = normalizedPath(entry.name).split("/").slice(1).join("/");
    const relativePath = link.subPath
      ? repositoryPath.slice(link.subPath.length).replace(/^\//u, "")
      : repositoryPath;
    return { path: normalizedPath(relativePath), content: entry.content };
  }).filter((entry) => entry.path);
  if (entries.length > MAX_GITHUB_FILES) throw new Error(`GitHub 目录包含超过 ${MAX_GITHUB_FILES} 个可读文件，请改为粘贴具体 Skill 子目录链接`);
  const selectedBytes = entries.reduce((total, entry) => total + entry.content.length, 0);
  if (selectedBytes > MAX_GITHUB_SELECTED_BYTES) throw new Error("GitHub Skill 展开内容超过 12 MB，请改为粘贴更具体的子目录链接");
  const skillEntries = entries.filter((entry) => SKILL_FILE.test(entry.path));
  if (!skillEntries.length) throw new Error("所选 GitHub 目录中没有找到 SKILL.md");
  return { entries, skillEntries, selectedBytes };
};

const analyzeEntries = ({ entries, skillEntries }, link) => {
  const shallowest = Math.min(...skillEntries.map((entry) => entry.path.split("/").length));
  const shallowSkills = skillEntries.filter((entry) => entry.path.split("/").length === shallowest);
  const candidateRoot = shallowSkills.length === 1 ? posix.dirname(shallowSkills[0].path) : "";
  const uniqueRoot = shallowSkills.length === 1 && skillEntries.every((entry) => candidateRoot === "." || entry.path === shallowSkills[0].path || entry.path.startsWith(`${candidateRoot}/`));
  const rebase = (path) => uniqueRoot && candidateRoot !== "." ? path.slice(candidateRoot.length).replace(/^\//u, "") : path;
  const scopedEntries = uniqueRoot
    ? entries.filter((entry) => candidateRoot === "." || entry.path.startsWith(`${candidateRoot}/`)).map((entry) => ({ ...entry, path: rebase(entry.path) }))
    : entries;
  const scopedSkills = scopedEntries.filter((entry) => SKILL_FILE.test(entry.path));
  const rootEntry = uniqueRoot ? scopedSkills.find((entry) => entry.path.toLowerCase() === "skill.md") || null : null;
  const childEntries = rootEntry ? scopedSkills.filter((entry) => entry !== rootEntry) : scopedSkills;
  const usedIds = new Set();
  const usedNames = new Set();
  const normalizedRoot = rootEntry ? normalizedSkillSource({
    source: rootEntry.content.toString("utf8"),
    owner: link.owner,
    repository: link.repository,
    sourcePath: rootEntry.path,
    sourceUrl: link.sourceUrl,
    usedIds,
    usedNames,
    fallbackName: readablePathName(link.repository, "GitHub Skill"),
  }) : null;
  const children = childEntries.map((entry) => normalizedSkillSource({
    source: entry.content.toString("utf8"),
    owner: link.owner,
    repository: link.repository,
    sourcePath: entry.path,
    sourceUrl: link.sourceUrl,
    usedIds,
    usedNames,
    fallbackName: readablePathName(posix.basename(posix.dirname(entry.path)), link.repository),
  }));
  const skillCount = children.length + (normalizedRoot ? 1 : 0);
  const families = unique(children.map((child) => capabilityFamily(child.capabilities)));
  const originalGroups = unique(children.map((child) => normalizedPath(posix.dirname(child.sourcePath)).split("/").filter(Boolean)[0] || ""));
  const nested = children.some((child) => normalizedPath(posix.dirname(child.sourcePath)).split("/").filter(Boolean).length >= 3);
  const naturalGroupCount = Math.max(families.length, originalGroups.length);
  const compatibleTypes = skillCount <= 1 ? ["skill"] : naturalGroupCount >= 2 ? ["module", "group"] : ["module"];
  const recommendedType = compatibleTypes.includes("group") && (families.length >= 2 || nested || children.length > 8) ? "group" : compatibleTypes[0];
  return {
    entries: scopedEntries,
    root: normalizedRoot,
    children,
    skillCount,
    families,
    originalGroups,
    recommendedType,
    compatibleTypes,
  };
};

const syntheticRoot = ({ link, children }) => normalizedSkillSource({
  source: `# ${readablePathName(link.repository, "GitHub Skill 集合")}\n\n这是从 GitHub 仓库导入的复合 Skill。根据用户明确任务和当前插槽授权，选择内部最匹配的子 Skill；不得自行扩大权限或执行仓库脚本。\n\n## 子 Skill\n\n${children.map((child) => `- ${child.name}：${child.description}`).join("\n")}`,
  owner: link.owner,
  repository: link.repository,
  sourcePath: "SKILL.md",
  sourceUrl: link.sourceUrl,
  usedIds: new Set(children.map((child) => child.id)),
  usedNames: new Set(children.map((child) => child.name.toLocaleLowerCase("zh-CN"))),
  fallbackName: `${readablePathName(link.repository, "GitHub Skill")}能力集`,
});

const packageForType = (snapshot, requestedType) => {
  const type = snapshot.analysis.compatibleTypes.includes(requestedType) ? requestedType : snapshot.analysis.recommendedType;
  if (type === "skill" && snapshot.analysis.skillCount !== 1) throw new Error("该仓库包含多个 Skill，不能作为单一 Skill 安装");
  const root = type === "skill"
    ? snapshot.analysis.root || snapshot.analysis.children[0]
    : snapshot.analysis.root || syntheticRoot({ link: snapshot.link, children: snapshot.analysis.children });
  if (!root) throw new Error("GitHub 目录中没有可安装的 Skill");
  const entries = [{ name: "SKILL.md", content: root.source }];
  if (type !== "skill") {
    const families = snapshot.analysis.families;
    const originalGroups = snapshot.analysis.originalGroups;
    const useFamilies = families.length >= 2;
    const useOriginalGroups = !useFamilies && originalGroups.length >= 2;
    const usedPackagePaths = new Set();
    for (const child of snapshot.analysis.children) {
      const baseName = fileSegment(child.name, "skill");
      let path = `skills/${baseName}/SKILL.md`;
      if (type === "group") {
        const originalGroup = normalizedPath(posix.dirname(child.sourcePath)).split("/").filter(Boolean)[0] || "辅助参考能力";
        const groupName = useFamilies ? capabilityFamily(child.capabilities) : useOriginalGroups ? readablePathName(originalGroup, "辅助参考能力") : "辅助参考能力";
        path = `skills/${fileSegment(groupName, "能力模块")}/${baseName}/SKILL.md`;
      }
      if (usedPackagePaths.has(path.toLocaleLowerCase("en-US"))) {
        const suffix = createHash("sha1").update(child.sourcePath).digest("hex").slice(0, 6);
        path = path.replace(/\/SKILL\.md$/iu, `-${suffix}/SKILL.md`);
      }
      usedPackagePaths.add(path.toLocaleLowerCase("en-US"));
      entries.push({ name: path, content: child.source });
    }
  }
  const support = snapshot.analysis.entries.filter((entry) => !SKILL_FILE.test(entry.path) && SAFE_SUPPORT_FILE.test(entry.path));
  let supportBytes = 0;
  for (const file of support) {
    if (supportBytes + file.content.length > 768 * 1024) break;
    const path = normalizedPath(`references/github-source/${file.path}`);
    if (path.length > 220) continue;
    entries.push({ name: path, content: file.content });
    supportBytes += file.content.length;
  }
  const manifest = {
    packageFormat: "shensi-skill-package-v1",
    schemaVersion: 2,
    id: root.id,
    version: root.version,
    sourceType: "github",
    sourceUrl: snapshot.link.sourceUrl,
    resolvedCommit: snapshot.resolvedCommit,
    requestedType: type,
  };
  entries.push({ name: "manifest.json", content: JSON.stringify(manifest, null, 2) });
  const bytes = zipStore(entries, new Date(0));
  if (bytes.length > 4 * 1024 * 1024) throw new Error("转换后的 Skill 包超过 4 MB，请粘贴更具体的 GitHub 子目录链接");
  return { type, bytes, packageHash: hashBytes(bytes), root, childCount: snapshot.analysis.children.length };
};

const pruneSnapshots = () => {
  const now = Date.now();
  for (const [id, snapshot] of snapshots) if (snapshot.expiresAt <= now) snapshots.delete(id);
  while (snapshots.size >= MAX_GITHUB_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value);
};

const publicSnapshot = (snapshot) => ({
  snapshotId: snapshot.id,
  sourceUrl: snapshot.link.sourceUrl,
  owner: snapshot.link.owner,
  repository: snapshot.link.repository,
  resolvedCommit: snapshot.resolvedCommit,
  recommendedType: snapshot.analysis.recommendedType,
  compatibleTypes: snapshot.analysis.compatibleTypes,
  skillCount: snapshot.analysis.skillCount,
  root: snapshot.analysis.root ? {
    id: snapshot.analysis.root.id,
    name: snapshot.analysis.root.name,
    description: snapshot.analysis.root.description,
    capabilities: snapshot.analysis.root.capabilities,
    sourcePath: snapshot.analysis.root.sourcePath,
    family: capabilityFamily(snapshot.analysis.root.capabilities),
  } : null,
  children: snapshot.analysis.children.map((child) => ({
    id: child.id,
    name: child.name,
    description: child.description,
    capabilities: child.capabilities,
    sourcePath: child.sourcePath,
    family: capabilityFamily(child.capabilities),
  })),
  expiresAt: snapshot.expiresAt,
});

export const downloadGithubSkillSnapshot = async ({ url, fetchImpl = fetch } = {}) => {
  pruneSnapshots();
  const link = parseGithubSkillUrl(url);
  const repository = await githubJson(`https://api.github.com/repos/${encodeURIComponent(link.owner)}/${encodeURIComponent(link.repository)}`, fetchImpl);
  const requestedRef = link.ref || repository.default_branch;
  if (!requestedRef) throw new Error("GitHub 仓库没有可下载的默认分支");
  const commit = await githubJson(`https://api.github.com/repos/${encodeURIComponent(link.owner)}/${encodeURIComponent(link.repository)}/commits/${encodeURIComponent(requestedRef)}`, fetchImpl);
  const resolvedCommit = String(commit.sha || "").trim();
  if (!/^[a-f0-9]{40}$/iu.test(resolvedCommit)) throw new Error("GitHub 没有返回可锁定的提交版本");
  const archiveResponse = await fetchImpl(`https://codeload.github.com/${encodeURIComponent(link.owner)}/${encodeURIComponent(link.repository)}/zip/${resolvedCommit}`, {
    headers: { Accept: "application/zip", "User-Agent": "Shensi-Creative-Engine" },
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!archiveResponse.ok) throw new Error(`GitHub 仓库下载失败（${archiveResponse.status}）`);
  const archiveBytes = await readLimitedResponse(archiveResponse, MAX_GITHUB_ARCHIVE_BYTES);
  const selected = selectedArchiveEntries(archiveBytes, link);
  const analysis = analyzeEntries(selected, link);
  const snapshot = {
    id: randomUUID(),
    link,
    resolvedCommit,
    archiveHash: hashBytes(archiveBytes),
    analysis,
    packages: new Map(),
    expiresAt: Date.now() + GITHUB_SNAPSHOT_TTL_MS,
  };
  snapshots.set(snapshot.id, snapshot);
  return publicSnapshot(snapshot);
};

export const prepareGithubSkillSnapshot = ({ snapshotId, requestedType = "" } = {}) => {
  pruneSnapshots();
  const snapshot = snapshots.get(String(snapshotId || ""));
  if (!snapshot) throw new Error("GitHub Skill 分析结果已过期，请重新读取链接");
  const type = snapshot.analysis.compatibleTypes.includes(requestedType) ? requestedType : snapshot.analysis.recommendedType;
  if (!snapshot.packages.has(type)) snapshot.packages.set(type, packageForType(snapshot, type));
  return { ...publicSnapshot(snapshot), ...snapshot.packages.get(type) };
};

export const forgetGithubSkillSnapshot = (snapshotId = "") => snapshots.delete(String(snapshotId || ""));
