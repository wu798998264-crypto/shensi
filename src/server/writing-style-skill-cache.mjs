import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const MAX_FILES = 24;
const MAX_FILE_CHARS = 80_000;
const MAX_TOTAL_CHARS = 160_000;
const cache = new Map();
const counters = { fileReads: 0, cacheHits: 0 };

const inside = (candidate, parent) => {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const referencesFrom = (content = "") => {
  const found = [];
  const source = String(content ?? "");
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+\.(?:md|txt))\)/giu)) found.push(match[1]);
  for (const match of source.matchAll(/`([^`\r\n]+\.(?:md|txt))`/giu)) found.push(match[1]);
  let requiredSection = false;
  for (const line of source.split(/\r?\n/u)) {
    if (/^#{1,6}\s+/u.test(line)) requiredSection = /必读|必须读取|required(?:\s+files?)?|规则文件/iu.test(line);
    if (!requiredSection && !/必读|必须读取|required(?:\s+files?)?|规则文件/iu.test(line)) continue;
    for (const match of line.matchAll(/(?:^|[\s（(：:、])([^\s（）()<>，。；;]+\.(?:md|txt))(?=$|[\s）)、，。；;])/giu)) found.push(match[1]);
  }
  return [...new Set(found.map((item) => String(item).trim().replace(/^<|>$/g, "")).filter((item) => item && !/^(?:https?:|file:)/iu.test(item)))];
};

const revisionFor = async (path) => {
  const value = await stat(path);
  return `${value.size}:${value.mtimeMs}`;
};

const readCached = async (path) => {
  const revision = await revisionFor(path);
  const previous = cache.get(path);
  if (previous?.revision === revision) {
    counters.cacheHits += 1;
    return { ...previous, cacheHit: true };
  }
  const content = await readFile(path, "utf8");
  counters.fileReads += 1;
  const value = {
    revision,
    content,
    hash: createHash("sha256").update(content, "utf8").digest("hex"),
  };
  cache.set(path, value);
  return { ...value, cacheHit: false };
};

export const clearWritingSkillRuleCache = () => {
  cache.clear();
  counters.fileReads = 0;
  counters.cacheHits = 0;
};

export const writingSkillRuleCacheStats = () => ({ ...counters, entries: cache.size });

export const loadWritingSkillRuleSources = async ({ sourcePath = "", content = "", allowedRoot = "" } = {}) => {
  const source = resolve(String(sourcePath || ""));
  const base = dirname(source);
  const root = allowedRoot ? resolve(allowedRoot) : base;
  const files = [];
  const failures = [];
  let total = 0;
  let cacheHits = 0;
  for (const reference of referencesFrom(content).slice(0, MAX_FILES)) {
    const target = resolve(base, ...reference.replaceAll("\\", "/").split("/"));
    const label = relative(base, target).replaceAll("\\", "/");
    if (!inside(target, root) || target === source) {
      failures.push({ path: label || reference, reason: "outside_skill_package" });
      continue;
    }
    try {
      const loaded = await readCached(target);
      if (!loaded.content.trim()) {
        failures.push({ path: label, reason: "empty" });
        continue;
      }
      if (loaded.content.length > MAX_FILE_CHARS || total + loaded.content.length > MAX_TOTAL_CHARS) {
        failures.push({ path: label, reason: "rule_budget_exceeded" });
        continue;
      }
      total += loaded.content.length;
      cacheHits += loaded.cacheHit ? 1 : 0;
      files.push({ path: label, hash: loaded.hash, content: loaded.content, contentLength: loaded.content.length, fullText: true, truncated: false });
    } catch (error) {
      failures.push({ path: label, reason: "read_failed", error: String(error?.message || error).slice(0, 300) });
    }
  }
  return { files, failures, cacheHits, blocking: false };
};
