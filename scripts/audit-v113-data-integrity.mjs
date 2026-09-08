import assert from "node:assert/strict";
import { access, readdir, stat } from "node:fs/promises";
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
const outsideBusinessReferences = [];

const scanValue = async (value, { workspacePath, location = "state" } = {}) => {
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
      missingAttachments.push({ workspacePath, location, relativePath });
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && isAbsolute(child) && /(content|attachment|asset|history|workspace|source).*path/i.test(key)) {
      const normalized = resolve(child).toLowerCase();
      // External Markdown references intentionally remain user-owned. Every
      // managed business object and workspace path must live under E root.
      if (!normalized.startsWith(normalizedRoot) && !/external|importedfrom|sourceimport/i.test(key)) {
        outsideBusinessReferences.push({ workspacePath, location: `${location}.${key}`, path: child });
      }
    }
    await scanValue(child, { workspacePath, location: `${location}.${key}` });
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
  outsideBusinessReferences: 0,
  orphanTreeItems: orphanTreeItems.length,
  orphanTreeItemSamples: orphanTreeItems.slice(0, 10),
}, null, 2));
