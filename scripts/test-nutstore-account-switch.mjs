import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNutstoreSyncEngine } from "../src/server/nutstore-sync/sync-engine.mjs";

const root = await mkdtemp(join(tmpdir(), "shensi-nutstore-account-switch-"));
try {
  const engine = createNutstoreSyncEngine({
    dataRoot: join(root, "data"),
    machineRoot: join(root, "machine"),
    desktopRuntime: true,
    clientFactory: () => ({}),
    repositoryFactory: async () => ({
      initialize: async () => {},
      inventory: async () => [],
    }),
    capabilityProbe: async () => ({
      capabilityLevel: "safe_auto", propfind: true, get: true, put: true, delete: true,
      move: true, conditionalMove: true, etag: true, ifMatch: true, ifNoneMatch: true, cleanup: true, reasons: [],
    }),
  });

  await engine.configure({ account: "old@example.com", password: "old-app-password", autoSync: true });
  await engine.stateStore.update((state) => {
    state.enabled = true;
    state.activeMode = "nutstore_direct";
    state.baseline = { "作品/旧账号.md": { hash: "old" } };
    state.remoteCursor = "old-cursor";
    state.outbox = [{ id: "old-op", status: "pending", logicalPath: "作品/旧账号.md" }];
    state.conflicts = [{ id: "old-conflict", status: "unresolved", logicalPath: "作品/旧账号.md" }];
    state.operations = [{ id: "old-operation", logicalPath: "作品/旧账号.md" }];
    state.capability = { capabilityLevel: "safe_auto" };
  });
  await engine.setSessionCredentials({ account: "old@example.com", password: "old-app-password" });

  const switched = await engine.switchAccount();
  assert.equal(switched.enabled, false);
  assert.equal(switched.activeMode, "none");
  assert.equal(switched.account, "");
  assert.equal(switched.credentialAvailable, false);
  assert.equal(switched.autoSync, false);
  const state = await engine.stateStore.load();
  assert.deepEqual(state.baseline, {});
  assert.deepEqual(state.outbox, []);
  assert.deepEqual(state.conflicts, []);
  assert.deepEqual(state.operations, []);
  assert.equal(state.remoteCursor, "");
  const persisted = await readFile(engine.stateStore.paths.statePath, "utf8");
  assert.doesNotMatch(persisted, /old-app-password|new-app-password/u, "同步状态文件不得保存坚果云应用密码");

  await engine.setSessionCredentials({ account: "new@example.com", password: "new-app-password" });
  await engine.configure({ account: "new@example.com", password: "new-app-password", autoSync: false });
  await engine.stateStore.update((draft) => { draft.enabled = true; draft.activeMode = "nutstore_direct"; });
  const enabled = await engine.setAutoSync({ autoSync: true });
  assert.equal(enabled.autoSync, true);
  assert.equal(enabled.account, "new@example.com");
  const disabled = await engine.setAutoSync({ autoSync: false });
  assert.equal(disabled.autoSync, false);

  const manualEngine = createNutstoreSyncEngine({
    dataRoot: join(root, "manual-data"),
    machineRoot: join(root, "manual-machine"),
    desktopRuntime: true,
    clientFactory: () => ({}),
    repositoryFactory: async () => ({ initialize: async () => {}, inventory: async () => [] }),
    capabilityProbe: async () => ({ capabilityLevel: "safe_manual", propfind: true, get: true, put: true, delete: true, move: true, conditionalMove: false, etag: true, ifMatch: true, ifNoneMatch: false, cleanup: true, reasons: ["manual only"] }),
  });
  await manualEngine.configure({ account: "manual@example.com", password: "manual-password", autoSync: false });
  await manualEngine.stateStore.update((draft) => { draft.enabled = true; draft.activeMode = "nutstore_direct"; });
  await assert.rejects(() => manualEngine.setAutoSync({ autoSync: true }), (error) => error?.code === "NUTSTORE_AUTO_SYNC_UNSUPPORTED");
  console.log("Nutstore account switch and connected auto-sync regression checks passed");
} finally {
  await rm(root, { recursive: true, force: true });
}

const [app, server] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../server.mjs", import.meta.url), "utf8"),
]);
assert.match(app, /id="nutstoreConnectedControls"/u);
assert.match(app, /id="switchNutstoreAccount"/u);
assert.match(app, /\/api\/sync\/nutstore\/switch-account/u);
assert.match(app, /\/api\/sync\/nutstore\/preferences/u);
assert.match(server, /nutstoreSyncEngine\.switchAccount\(\)/u);
assert.match(server, /nutstoreSyncEngine\.setAutoSync\(/u);
