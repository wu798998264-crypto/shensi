import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadWorkspaceDirectoryState, loadWorkspaceState } from "../src/server/workspace.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = join(root, "runtime", `v300-performance-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const internalRoot = join(workspaceRoot, ".shensi");
const makeDocument = (index) => ({
  title: `第${index + 1}章 性能验收`,
  moduleId: "manuscript",
  documentKind: "document",
  html: `<p>${"正文性能数据。".repeat(18_000)}</p>`,
  markdown: "",
  updatedAt: "2026-08-24T00:00:00.000Z",
});

try {
  await mkdir(internalRoot, { recursive: true });
  const documents = Object.fromEntries(Array.from({ length: 140 }, (_, index) => [`chapter-${index + 1}`, makeDocument(index)]));
  const state = {
    projectName: "v3.0 大工作区性能夹具",
    workspaceKind: "project",
    activeDocument: "chapter-1",
    activeModule: "manuscript",
    documents,
    moduleItems: { manuscript: Object.keys(documents).map((id) => [id, documents[id].title, { workspaceView: "novel" }]) },
    conversations: [{ id: "conversation-main", messages: [] }],
    workspaceAssets: Array.from({ length: 1_200 }, (_, index) => ({ id: `asset-${index}`, name: `素材${index}`, createdAt: "2026-08-24T00:00:00.000Z" })),
  };
  await writeFile(join(internalRoot, "current-state.json"), JSON.stringify(state), "utf8");
  await writeFile(join(internalRoot, "manifest.json"), JSON.stringify({ manifest: {} }), "utf8");

  const directoryStartedAt = performance.now();
  const directory = await loadWorkspaceDirectoryState({ appRoot: root, requestedPath: workspaceRoot });
  const directoryElapsedMs = performance.now() - directoryStartedAt;
  assert.equal(Object.keys(directory.state.documents).length, 140);
  assert.equal(directory.state.workspaceAssets.length, 1_200);
  assert.ok(directoryElapsedMs < 12_000, `35MB 级目录读取过慢：${directoryElapsedMs.toFixed(0)}ms`);

  const loadStartedAt = performance.now();
  const loaded = await loadWorkspaceState({ appRoot: root, requestedPath: workspaceRoot });
  const loadElapsedMs = performance.now() - loadStartedAt;
  assert.equal(loaded.state.activeDocument, "chapter-1");
  assert.ok(loaded.state.documents["chapter-1"].html.includes("正文性能数据"));
  assert.ok(loadElapsedMs < 20_000, `35MB 级工作区读取超时：${loadElapsedMs.toFixed(0)}ms`);
  assert.ok(Number(process.memoryUsage().heapUsed) < 900 * 1024 * 1024, "大工作区读取占用内存异常");
  console.log(JSON.stringify({
    name: "v3.0 大工作区性能测试通过",
    bytes: Buffer.byteLength(JSON.stringify(state)),
    directoryElapsedMs: Math.round(directoryElapsedMs),
    loadElapsedMs: Math.round(loadElapsedMs),
    documentCount: Object.keys(loaded.state.documents).length,
  }));
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}
