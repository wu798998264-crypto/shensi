import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createBlankProjectState } from "../src/data.js";
import {
  emptyMemoryStore,
  ensureMemoryStore,
  isEmptyMemoryProjectionPlaceholder,
  memoryStoreProjectionFingerprint,
  normalizeMemoryStore,
  projectMemoryStoreDocumentHtml,
  projectMemoryStoreMarkdown,
} from "../src/structured-memory-store.js";
import { loadWorkspaceState, saveWorkspaceState } from "../src/server/workspace.mjs";

const root = await mkdtemp(join(tmpdir(), "shensi-v318-memory-roundtrip-"));
try {
  const appRoot = join(root, "app");
  const workspacePath = join(appRoot, "runtime", "作品", "记忆投影往返验收");
  const state = createBlankProjectState("记忆投影往返验收");
  const migratedTemplate = ensureMemoryStore({ documents: state.documents });
  assert.equal(
    Object.values(migratedTemplate.informationEntities).some((record) => record.name === "信息账本" && /当前没有已通过正文证据验收的记录/u.test(record.detail)),
    false,
    "内置信息账本空占位不得迁移成真实信息记录",
  );
  state.memoryStore = emptyMemoryStore();
  state.memoryStore.informationEntities["information-copper-heart"] = {
    id: "information-copper-heart",
    name: "铜心",
    detail: "靠近主炉时会发热。",
    source: { documentId: "chapter-1", revision: "rev-1", quote: "靠近主炉时会发热。", claim: "靠近主炉时会发热。" },
    release: { state: "planned" },
    status: "active",
    updatedAt: "2026-09-08T00:00:00.000Z",
  };
  state.memoryStore.informationEntities["information-ledger-meta"] = {
    id: "information-ledger-meta",
    name: "信息账本",
    detail: "用于验证同名记录标题在往返过程中不会触发误报。",
    source: { documentId: "chapter-1", revision: "rev-1", quote: "信息账本仍保持原有内容。", claim: "信息账本投影稳定。" },
    status: "active",
    updatedAt: "2026-09-08T00:00:00.000Z",
  };
  for (const documentId of ["memory-release", "memory-foreshadowing", "memory-information-ledger", "script-memory-information-ledger"]) {
    const documentState = state.documents[documentId];
    const projection = {
      markdown: projectMemoryStoreMarkdown({ store: state.memoryStore, documentId }),
      html: projectMemoryStoreDocumentHtml({ store: state.memoryStore, documentId }),
    };
    documentState.markdown = projection.markdown;
    documentState.html = projection.html;
    documentState.memoryStoreProjectionHash = memoryStoreProjectionFingerprint({ documentId, html: projection.html });
    documentState.memoryStoreProjectionHashVersion = 2;
  }

  await saveWorkspaceState({ appRoot, requestedPath: workspacePath, state });
  const compact = JSON.parse(await readFile(join(workspacePath, ".shensi", "current-state.json"), "utf8"));
  assert.ok(compact.memoryStore, "结构化记忆仓必须随工作区状态持久化");
  assert.equal(Object.keys(compact.memoryStore.informationEntities).length, 2);

  const loaded = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
  assert.ok(loaded.state.memoryStore, "重启加载后必须恢复结构化记忆仓");
  assert.equal(Object.keys(loaded.state.memoryStore.informationEntities).length, 2);
  assert.match(loaded.state.documents["memory-release"].html, /铜心/u);
  assert.equal(loaded.state.documents["memory-release"].memoryStoreProjectionHashVersion, 2);
  for (const documentId of ["memory-release", "memory-foreshadowing", "memory-information-ledger", "script-memory-information-ledger"]) {
    const documentState = loaded.state.documents[documentId];
    assert.equal(
      memoryStoreProjectionFingerprint({ documentId, html: documentState.html }),
      documentState.memoryStoreProjectionHash,
      `${documentId} 保存并重启后的稳定指纹必须保持一致`,
    );
  }

  const syntheticRecordStore = emptyMemoryStore();
  syntheticRecordStore.informationEntities["information-e5tskz"] = {
    id: "information-e5tskz",
    name: "信息账本",
    detail: "<!-- memory-store-schema: 1 --> 当前没有已通过正文证据验收的记录。",
    status: "legacy",
    source: {},
  };
  assert.deepEqual(Object.keys(normalizeMemoryStore(syntheticRecordStore).informationEntities), [], "旧版生成的空占位伪记录必须在加载时清理");
  assert.equal(isEmptyMemoryProjectionPlaceholder({
    documentId: "memory-information-ledger",
    html: "<h2>信息账本</h2><p><strong>稳定 ID：</strong>information-e5tskz</p><p><strong>当前事实：</strong>&lt;!-- memory-store-schema: 1 --&gt; 当前没有已通过正文证据验收的记录。</p><p><strong>状态：</strong>legacy</p><p><strong>证据：</strong>待确认</p><p><strong>最后更新：</strong>待确认</p>",
  }), true, "旧版空占位投影必须可被安全识别并重建");
  console.log("v3.1.8 memory projection persistence roundtrip passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
