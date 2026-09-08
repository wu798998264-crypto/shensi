import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createNutstoreLocalState } from "../src/server/nutstore-sync/local-state.mjs";
import { createNutstoreSyncEngine } from "../src/server/nutstore-sync/sync-engine.mjs";

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const acceptanceRoot = resolve(sourceRoot, "artifacts", "manual-acceptance-20260825", "nutstore-controlled");
const reportPath = resolve(sourceRoot, "artifacts", "manual-acceptance-20260825", "nutstore-controlled-conflict.json");
const uiMachineRoot = resolve(sourceRoot, "artifacts", "manual-acceptance-20260825", "history-sandbox-data");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const withinAcceptanceRoot = (target) => target === acceptanceRoot || target.startsWith(`${acceptanceRoot}${sep}`);

if (process.argv.includes("--resolve-ui-fixture")) {
  const store = createNutstoreLocalState({ machineRoot: uiMachineRoot });
  await store.update((state) => {
    for (const conflict of state.conflicts) {
      if (conflict.status === "unresolved") {
        conflict.status = "resolved";
        conflict.resolution = "keep_both";
        conflict.resolvedAt = new Date().toISOString();
      }
    }
    state.phase = "completed";
    state.lastSuccessfulSyncAt = new Date().toISOString();
    state.progress = { completed: 1, total: 1 };
  });
  console.log(JSON.stringify({ ok: true, uiFixture: "resolved" }));
  process.exit(0);
}

assert.equal(withinAcceptanceRoot(acceptanceRoot), true, "受控验收目录必须位于指定 artifacts 范围内");
await rm(acceptanceRoot, { recursive: true, force: true });
await mkdir(acceptanceRoot, { recursive: true });

const capabilityProbe = async () => ({
  capabilityLevel: "safe_auto",
  ifMatch: true,
  move: true,
  cleanup: true,
  options: { dav: "1,2", allow: "OPTIONS, PROPFIND, PUT, GET, DELETE, MOVE" },
});
const clientFactory = () => ({});

const createSharedRepositoryFactory = () => {
  const files = new Map();
  let revision = 0;
  const metadata = (logicalPath, record) => ({
    logicalPath,
    hash: sha256(record.content),
    size: record.content.length,
    contentType: "text/markdown",
    etag: record.etag,
    deleted: false,
    updatedAt: record.updatedAt,
  });
  const factory = async () => ({
    initialize: async () => {},
    inventory: async () => [...files.entries()].map(([logicalPath, record]) => metadata(logicalPath, record)),
    upload: async ({ entry, expectedRemoteEtag = "" }) => {
      const current = files.get(entry.logicalPath);
      if (expectedRemoteEtag && current?.etag !== expectedRemoteEtag) throw Object.assign(new Error("远端 ETag 已变化"), { code: "REMOTE_ETAG_CHANGED" });
      const content = await readFile(entry.sourcePath);
      revision += 1;
      const record = { content, etag: `controlled-${revision}`, updatedAt: new Date().toISOString() };
      files.set(entry.logicalPath, record);
      return metadata(entry.logicalPath, record);
    },
    download: async ({ entry, temporaryPath }) => {
      const record = files.get(entry.logicalPath);
      assert.ok(record, `远端文件不存在：${entry.logicalPath}`);
      await mkdir(dirname(temporaryPath), { recursive: true });
      await writeFile(temporaryPath, record.content);
      return { size: record.content.length, etag: record.etag };
    },
    remove: async ({ entry }) => { files.delete(entry.logicalPath); return { deleted: true }; },
    acknowledgeDeletion: async () => ({ acknowledged: true }),
  });
  return { factory, files };
};

const config = (deviceName) => ({
  endpoint: "https://dav.jianguoyun.com/dav/",
  account: "controlled-acceptance@example.invalid",
  password: "controlled-test-password",
  remoteRoot: "/ShensiAcceptance/controlled/",
  deviceName,
  autoSync: false,
});

const results = [];
let unresolvedUiConflict = null;
for (const resolution of ["use_local", "use_remote", "keep_both"]) {
  const scenarioRoot = join(acceptanceRoot, resolution);
  const dataRootA = join(scenarioRoot, "device-a-data");
  const dataRootB = join(scenarioRoot, "device-b-data");
  const machineRootA = join(scenarioRoot, "device-a-machine");
  const machineRootB = join(scenarioRoot, "device-b-machine");
  const logicalPath = `作品/冲突人工验收/${resolution}.md`;
  const localPathA = join(dataRootA, ...logicalPath.split("/"));
  const localPathB = join(dataRootB, ...logicalPath.split("/"));
  const baseline = Buffer.from(`# 冲突恢复样本\n\n共同基线：${resolution}\n`, "utf8");
  const remoteA = Buffer.from(`# 冲突恢复样本\n\n冲突内容：设备 A 已先同步。\n`, "utf8");
  const localB = Buffer.from(`# 冲突恢复样本\n\n冲突内容：设备 B 基于旧版本修改。\n`, "utf8");
  await mkdir(dirname(localPathA), { recursive: true });
  await writeFile(localPathA, baseline);

  const shared = createSharedRepositoryFactory();
  const engineOptions = (dataRoot, machineRoot) => ({ dataRoot, machineRoot, desktopRuntime: true, repositoryFactory: shared.factory, clientFactory, capabilityProbe });
  const engineA = createNutstoreSyncEngine(engineOptions(dataRootA, machineRootA));
  const engineB = createNutstoreSyncEngine(engineOptions(dataRootB, machineRootB));

  await engineA.configure(config(`受控设备 A-${resolution}`));
  const previewA = await engineA.firstSyncPreview();
  await engineA.enable({ previewToken: previewA.previewToken });
  await engineB.configure(config(`受控设备 B-${resolution}`));
  const previewB = await engineB.firstSyncPreview();
  await engineB.enable({ previewToken: previewB.previewToken });
  assert.deepEqual(await readFile(localPathB), baseline, `${resolution}：设备 B 初次下载失败`);

  await writeFile(localPathA, remoteA);
  await engineA.noteLocalChange(logicalPath);
  await engineA.run({ reason: `controlled-${resolution}-device-a` });
  await writeFile(localPathB, localB);
  await engineB.noteLocalChange(logicalPath);
  const conflictRun = await engineB.run({ reason: `controlled-${resolution}-device-b` });
  const conflicts = await engineB.conflicts();
  assert.equal(conflicts.length, 1, `${resolution}：应只生成一个冲突`);
  assert.equal(conflictRun.status.phase, "conflict", `${resolution}：状态应进入冲突阶段`);
  unresolvedUiConflict ??= structuredClone(conflicts[0]);

  const resolutionRun = await engineB.resolveConflict({ conflictId: conflicts[0].id, resolution });
  const remaining = await engineB.conflicts();
  assert.equal(remaining.length, 0, `${resolution}：处理后不应重新生成同一冲突`);
  const remoteRecord = shared.files.get(logicalPath);
  const localAfter = await readFile(localPathB);
  const copies = (await import("node:fs/promises")).readdir(dirname(localPathB)).then((items) => items.filter((name) => name.includes(".conflict-remote-")));
  const conflictCopies = await copies;
  if (resolution === "use_local") {
    assert.deepEqual(remoteRecord.content, localB, "使用本地后远端应采用设备 B 内容");
    assert.deepEqual(localAfter, localB);
  } else if (resolution === "use_remote") {
    assert.deepEqual(localAfter, remoteA, "使用远端后设备 B 应采用设备 A 内容");
    assert.deepEqual(remoteRecord.content, remoteA);
  } else {
    assert.deepEqual(localAfter, localB, "保留双方后本地原文件应保留设备 B 内容");
    assert.deepEqual(remoteRecord.content, localB, "保留双方后本地版本应成为原路径的共同基线");
    assert.equal(conflictCopies.length, 1, "保留双方应生成一个远端冲突副本");
    assert.deepEqual(await readFile(join(dirname(localPathB), conflictCopies[0])), remoteA, "冲突副本应保存设备 A 远端内容");
  }

  const restarted = createNutstoreSyncEngine(engineOptions(dataRootB, machineRootB));
  const startup = await restarted.startup();
  assert.equal(startup.credentialAvailable, false, `${resolution}：重启不应持久化凭据`);
  await restarted.setSessionCredentials({ account: config("restart").account, password: config("restart").password });
  const recovered = await restarted.run({ reason: `controlled-${resolution}-restart` });
  assert.equal((await restarted.conflicts()).length, 0, `${resolution}：重启同步后不应出现残留冲突`);

  results.push({
    resolution,
    conflictId: conflicts[0].id,
    conflictKind: conflicts[0].kind,
    conflictDetected: true,
    unresolvedAfterResolution: remaining.length,
    restartPhase: recovered.status.phase,
    localHash: sha256(localAfter),
    remoteHash: sha256(remoteRecord.content),
    conflictCopies,
    resolutionSummary: resolutionRun.summary,
  });
}

const uiStore = createNutstoreLocalState({ machineRoot: uiMachineRoot });
await uiStore.update((state) => {
  state.enabled = true;
  state.paused = false;
  state.activeMode = "nutstore_direct";
  state.endpoint = "https://dav.jianguoyun.com/dav/";
  state.account = "controlled-acceptance@example.invalid";
  state.remoteRoot = "/ShensiAcceptance/controlled/";
  state.deviceName = "受控双实例验收";
  state.capabilityLevel = "safe_auto";
  state.capability = { capabilityLevel: "safe_auto", ifMatch: true, move: true, cleanup: true };
  state.phase = "conflict";
  state.progress = { completed: 1, total: 1 };
  state.conflicts = [{ ...unresolvedUiConflict, status: "unresolved", updatedAt: new Date().toISOString() }];
  state.lastSuccessfulSyncAt = new Date().toISOString();
});

const report = {
  schemaVersion: 1,
  kind: "controlled-two-device-nutstore-conflict",
  generatedAt: new Date().toISOString(),
  realNutstore: false,
  controlledRepository: true,
  ok: results.every((item) => item.conflictDetected && item.unresolvedAfterResolution === 0 && item.restartPhase === "completed"),
  results,
  uiFixture: { machineRoot: uiMachineRoot, conflictId: unresolvedUiConflict.id, status: "unresolved" },
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: report.ok, reportPath, results: results.map(({ resolution, conflictId, restartPhase }) => ({ resolution, conflictId, restartPhase })) }));
