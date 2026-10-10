import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createWhiteboardGenerationDraftPersistence } from "../src/whiteboard-generation-draft-persistence.js";
import { mergeWhiteboardGenerationDraftCaches, normalizeWhiteboardGenerationDraftCache, updateWhiteboardGenerationDraftCache, whiteboardGenerationDraftKey } from "../src/whiteboard-generation-draft.js";

const root = await mkdtemp(join(tmpdir(), "shensi-generation-drafts-"));
process.env.SHENSI_DATA_ROOT = root;
const { loadWhiteboardGenerationDrafts, saveWhiteboardGenerationDrafts } = await import("../src/server/whiteboard-generation-draft-store.mjs");
const { saveWorkspaceRecoveryCheckpoint, commitWorkspaceRecoveryCheckpoint } = await import("../src/server/recovery-store.mjs");
const { writeWhiteboardGenerationDraftJournal, readWhiteboardGenerationDraftJournal } = await import("../src/server/whiteboard-generation-draft-journal.mjs");
const options = { workspaceKind: "notebook", workspacePath: join(root, "我的笔记") };
const scope = { workspaceId: `notebook:${options.workspacePath.toLowerCase()}`, documentId: "board", nodeId: "video", channel: "video" };
const values = { prompt: "刚写的提示词\n@「图片2」 @「音频1」 @「图片2」最后一个字！",
  explicitReferences: "ref-b,audio-a,ref-a", referenceOrder: "ref-b,ref-a,audio-a",
  promptReferenceSequence: "ref-b,audio-a,ref-b", includeTargetReference: "1",
  connectionId: "existing-user-connection", model: "seedance2.5", duration: "22", aspectRatio: "9:16",
  resolution: "720p", generationMode: "smart_params", generateAudio: "true", videoCount: "1",
  multiframeTransitions: JSON.stringify([{ duration: 5, prompt: "切换 @「图片2」" }]), quality: "standard" };
const fresh = updateWhiteboardGenerationDraftCache({}, scope, values, { updatedAt: 200 });
try {
  // Reproduces the old failure: canonical commit clears dirty, but the toolbar
  // is NOT canonical document content and must still be restored independently.
  await saveWorkspaceRecoveryCheckpoint({ ...options, clientId: "legacy", revision: 1, state: { documents: {} }, baseStateStamp: "before-save", whiteboardGenerationDrafts: fresh });
  await commitWorkspaceRecoveryCheckpoint({ ...options, clientId: "legacy", revision: 1, stateStamp: "after-save" });
  assert.deepEqual((await loadWhiteboardGenerationDrafts(options)).cache.entries[whiteboardGenerationDraftKey(scope)].values, values);
  await saveWhiteboardGenerationDrafts({ ...options, cache: fresh, sessionUpdatedAt: 210 });
  const stale = updateWhiteboardGenerationDraftCache({}, scope, { prompt: "旧提示词", connectionId: "old-account" }, { updatedAt: 100 });
  await saveWhiteboardGenerationDrafts({ ...options, cache: stale, sessionUpdatedAt: 100 });
  assert.deepEqual((await loadWhiteboardGenerationDrafts(options)).cache.entries[whiteboardGenerationDraftKey(scope)].values, values);
  // Independent Node process, empty renderer storage and different origins:
  // reads the real fsynced store, not an in-memory mock/checkpoint dirty flag.
  const moduleUrl = new URL("../src/server/whiteboard-generation-draft-store.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `const {loadWhiteboardGenerationDrafts}=await import(${JSON.stringify(moduleUrl)});console.log(JSON.stringify(await loadWhiteboardGenerationDrafts(${JSON.stringify(options)})));`], { env: process.env, encoding: "utf8", windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout).cache.entries[whiteboardGenerationDraftKey(scope)].values, values);

  // Closing a bar is durable too; a stale open snapshot cannot revive it.
  const closed = { ...fresh, active: null, openSessions: [] };
  await saveWhiteboardGenerationDrafts({ ...options, cache: closed, sessionUpdatedAt: 300 });
  await saveWhiteboardGenerationDrafts({ ...options, cache: fresh, sessionUpdatedAt: 210 });
  assert.equal((await loadWhiteboardGenerationDrafts(options)).cache.active, null);
  const otherScope = { ...scope, workspaceId: "project:foreign", nodeId: "foreign" };
  const mixed = updateWhiteboardGenerationDraftCache(fresh, otherScope, { prompt: "不能串入" }, { updatedAt: 400 });
  await saveWhiteboardGenerationDrafts({ ...options, cache: mixed, sessionUpdatedAt: 400 });
  assert.equal(Object.keys((await loadWhiteboardGenerationDrafts(options)).cache.entries).length, 1);

  let many = {};
  for (let index = 0; index < 130; index++) many = updateWhiteboardGenerationDraftCache(many, { ...scope, nodeId: `card-${index}` }, { prompt: `草稿${index}` }, { updatedAt: index + 1 });
  assert.equal(Object.keys(normalizeWhiteboardGenerationDraftCache(many).entries).length, 130, "不能静默丢弃第121个之前的草稿");
  await saveWhiteboardGenerationDrafts({ ...options, cache: many, sessionUpdatedAt: 500 });
  assert.equal(Object.keys((await loadWhiteboardGenerationDrafts(options)).cache.entries).length, 131);

  let failed = true, errors = 0, saved = null;
  const persistence = createWhiteboardGenerationDraftPersistence({ delay: 60_000,
    send: async payload => { if (failed) throw new Error("disk full"); saved = payload; }, onError: () => errors++ });
  persistence.enqueue(fresh, { ...options, workspaceId: scope.workspaceId });
  await assert.rejects(persistence.flush(), /disk full/);
  assert.equal(persistence.hasPending(), true, "失败不得清空待保存值或误报成功");
  assert.equal(errors, 1);
  failed = false;
  await persistence.flush();
  assert.deepEqual(saved.cache.entries[whiteboardGenerationDraftKey(scope)].values, values);
  assert.equal(persistence.hasPending(), false);

  let release, delivered = [];
  const inFlight = createWhiteboardGenerationDraftPersistence({ delay: 60_000, send: async payload => {
    delivered.push(payload); if (delivered.length === 1) await new Promise(resolve => { release = resolve; });
  } });
  inFlight.enqueue(stale, { ...options, workspaceId: scope.workspaceId });
  const flush = inFlight.flush();
  await new Promise(resolve => setImmediate(resolve));
  inFlight.enqueue(fresh, { ...options, workspaceId: scope.workspaceId }); release(); await flush;
  assert.equal(delivered.length, 2);
  assert.deepEqual(delivered[1].cache.entries[whiteboardGenerationDraftKey(scope)].values, values);

  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /if \(checkpoint\?\.whiteboardGenerationDrafts\)/, "草稿读取不得受正文dirty门限限制");
  assert.match(app, /if \(dialog\.open\) saveWhiteboardGenerationDraft\(dialog\);[\s\S]{0,900}config\.form\.dataset\.nodeId = nodeId/, "先保存旧卡片再切换锚点");
  assert.match(app, /dialog\.dataset\.draftInitializing === "true"/, "初始化默认值不得覆盖真实草稿");
  assert.match(app, /onCloseRequested\?[\s\S]{0,650}flushWhiteboardGenerationDrafts\(\);[\s\S]{0,100}await whiteboardGenerationDraftPersistence\.flush\(\)/);
  assert.match(app, /confirmClose\?\.\(!draftSaveFailed && !whiteboardGenerationDraftPersistence\.hasPending\(\)\)/);
  assert.deepEqual(mergeWhiteboardGenerationDraftCaches(stale, fresh).entries[whiteboardGenerationDraftKey(scope)].values, values);
  const newest = updateWhiteboardGenerationDraftCache(fresh, scope, { ...values, prompt: `${values.prompt}断网且立即崩溃前最后一字` }, { updatedAt: Date.now() });
  const started = performance.now();
  for (let index = 0; index < 20; index++) {
    const entry = { ...newest.entries[whiteboardGenerationDraftKey(scope)], updatedAt: Date.now() + index };
    assert.equal(writeWhiteboardGenerationDraftJournal({ ...options, root, entry, active: newest.active }).ok, true);
  }
  const journal = readWhiteboardGenerationDraftJournal({ ...options, root });
  assert.equal(journal.cache.entries[whiteboardGenerationDraftKey(scope)].values.prompt.endsWith("崩溃前最后一字"), true);
  const afterCrash = await loadWhiteboardGenerationDrafts(options);
  assert.deepEqual(afterCrash.cache.entries[whiteboardGenerationDraftKey(scope)].values, newest.entries[whiteboardGenerationDraftKey(scope)].values, "HTTP尚未写入也必须从同步日志恢复");
  console.log(JSON.stringify({ synchronousJournalWrites: 20, averageMilliseconds: (performance.now() - started) / 20 }));
  console.log("生成操作栏独立持久化通过：完整参数/重复引用顺序/清洁检查点/跨进程/陈旧写入/关闭会话/跨工作区隔离/130草稿/失败重试/在途新编辑");
} finally { await rm(root, { recursive: true, force: true }); }
