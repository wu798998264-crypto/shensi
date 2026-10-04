import assert from "node:assert/strict";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { appDataRoot, persistentNotesRoot, persistentSkillsRoot, persistentWorksRoot } from "../src/server/app-data.mjs";
import { listWorkspaceNotebooks, listWorkspaceProjects, loadWorkspaceCurrentContent, loadWorkspaceState } from "../src/server/workspace.mjs";

const root = resolve(appDataRoot());
const normalizedRoot = root.toLowerCase();
assert.equal(normalizedRoot, resolve("E:\\ShensiUserData").toLowerCase());
for (const expected of [persistentWorksRoot(), persistentNotesRoot(), persistentSkillsRoot()]) {
  assert.equal(resolve(expected).toLowerCase().startsWith(normalizedRoot), true);
  assert.equal((await stat(expected)).isDirectory(), true);
}

const pathExists = async (path) => access(path).then(() => true, () => false);
const workspaces = [
  ...await listWorkspaceProjects({ appRoot: process.cwd() }),
  ...await listWorkspaceNotebooks(),
];
const rows = [];
const missingContent = [];
const orphanTreeItems = [];
const missingAttachments = [];
const recoverableMissingAttachments = [];
const outsideBusinessReferences = [];

// A completed media task can retain a verified vendor task ID even when an
// older migration removed only the materialized workspace copy. Keep this
// distinct from a genuinely orphaned attachment: the former is recoverable
// without resubmitting or charging a new generation, while the latter must
// continue to fail the data-integrity audit.
const generationJobs = new Map();
for (const entry of await readdir(join(root, "generation-jobs"), { withFileTypes: true }).catch(() => [])) {
  if (!entry.isFile() || !/^generation-[a-z0-9-]+\.json$/iu.test(entry.name)) continue;
  try {
    const job = JSON.parse(await readFile(join(root, "generation-jobs", entry.name), "utf8"));
    if (job?.id) generationJobs.set(String(job.id), job);
  } catch {
    // A malformed historical job is not allowed to turn a missing user file
    // into a false recoverable result; the attachment remains audit-failing.
  }
}

const recoverableJobFor = ({ workspacePath, relativePath, generationJobId = "" } = {}) => {
  const candidates = generationJobId && generationJobs.has(generationJobId)
    ? [generationJobs.get(generationJobId)]
    : [...generationJobs.values()];
  return candidates.find((job) => {
    if (job?.status !== "complete" || !String(job.providerTaskId || "").trim()) return false;
    if (resolve(String(job.target?.workspacePath || "")).toLowerCase() !== resolve(workspacePath).toLowerCase()) return false;
    const recorded = String(job.landingReceipt?.relativePath || job.result?.attachment?.relativePath || "").replaceAll("\\", "/");
    return recorded === String(relativePath || "").replaceAll("\\", "/")
      && Boolean(job.landingReceipt?.sha256 || job.result?.attachment?.sha256);
  }) || null;
};

const scanValue = async (value, { workspacePath, location = "state", generationJobId = "" } = {}) => {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) await scanValue(value[index], { workspacePath, location: `${location}[${index}]` });
    return;
  }
  if (!value || typeof value !== "object") return;
  const relativePath = String(value.relativePath || value.attachmentPath || "").trim();
  const looksLikeAttachment = relativePath && (
    String(value.mimeType || "").includes("/")
    || ["image", "video", "audio", "attachment"].includes(String(value.kind || "").toLowerCase())
  );
  if (looksLikeAttachment && !isAbsolute(relativePath)) {
    const target = resolve(workspacePath, relativePath);
    const rel = relative(workspacePath, target);
    if ((rel.startsWith("..") || isAbsolute(rel)) || !await pathExists(target)) {
      const recoverableJob = recoverableJobFor({
        workspacePath,
        relativePath,
        generationJobId,
      });
      if (recoverableJob) {
        recoverableMissingAttachments.push({
          workspacePath,
          location,
          relativePath,
          generationJobId: recoverableJob.id,
          providerTaskId: recoverableJob.providerTaskId,
        });
      } else {
        missingAttachments.push({ workspacePath, location, relativePath });
      }
    }
  }
  const nextGenerationJobId = String(
    value.generationJobId
      || value.generation?.jobId
      || generationJobId
      || "",
  ).trim();
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && isAbsolute(child) && /(content|attachment|asset|history|workspace|source).*path/i.test(key)) {
      const normalized = resolve(child).toLowerCase();
      // External Markdown references intentionally remain user-owned. Every
      // managed business object and workspace path must live under E root.
      if (!normalized.startsWith(normalizedRoot) && !/external|importedfrom|sourceimport/i.test(key)) {
        outsideBusinessReferences.push({ workspacePath, location: `${location}.${key}`, path: child });
      }
    }
    await scanValue(child, { workspacePath, location: `${location}.${key}`, generationJobId: nextGenerationJobId });
  }
};

for (const workspace of workspaces) {
  const loaded = await loadWorkspaceState({ appRoot: process.cwd(), requestedPath: workspace.workspacePath });
  const current = loaded.state ?? await loadWorkspaceCurrentContent({ appRoot: process.cwd(), requestedPath: workspace.workspacePath });
  const documents = current.documents || {};
  for (const [moduleId, items] of Object.entries(current.moduleItems || {})) {
    for (const [documentId, label] of Array.isArray(items) ? items : []) {
      if (documentId === "library-trash" || documents[documentId]) continue;
      orphanTreeItems.push({ workspace: workspace.name, moduleId, documentId, label });
    }
  }
  let historyCount = 0;
  for (const [documentId, document] of Object.entries(documents)) {
    if (document.externalContentMissing === true) missingContent.push({ workspace: workspace.name, documentId, title: document.title });
    const contentPath = String(document.contentRef?.path || "").trim();
    if (contentPath && !await pathExists(join(workspace.workspacePath, ...contentPath.split("/")))) {
      missingContent.push({ workspace: workspace.name, documentId, title: document.title, contentPath });
    }
  }
  historyCount = Object.values(current.histories || {}).reduce((total, entries) => total + (Array.isArray(entries) ? entries.length : 0), 0);
  await scanValue(current, { workspacePath: workspace.workspacePath });
  rows.push({ name: workspace.name, path: workspace.workspacePath, documents: Object.keys(documents).length, histories: historyCount });
}

assert.deepEqual(missingContent, []);
assert.deepEqual(missingAttachments, []);
assert.deepEqual(outsideBusinessReferences, []);

const topLevel = (await readdir(root, { withFileTypes: true })).map((entry) => entry.name).sort();
console.log(JSON.stringify({
  ok: true,
  dataRoot: root,
  topLevel,
  workspaces: rows.length,
  documents: rows.reduce((total, row) => total + row.documents, 0),
  histories: rows.reduce((total, row) => total + row.histories, 0),
  missingContent: 0,
  missingAttachments: 0,
  recoverableMissingAttachments: recoverableMissingAttachments.length,
  recoverableMissingAttachmentSamples: recoverableMissingAttachments.slice(0, 10),
  outsideBusinessReferences: 0,
  orphanTreeItems: orphanTreeItems.length,
  orphanTreeItemSamples: orphanTreeItems.slice(0, 10),
}, null, 2));
