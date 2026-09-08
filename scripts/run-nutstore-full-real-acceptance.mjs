import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createNutstoreSyncEngine } from "../src/server/nutstore-sync/sync-engine.mjs";
import { createWebDavClient } from "../src/server/nutstore-sync/webdav-client.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const outputPath = join(root, "artifacts", "nutstore-real-acceptance-20260825.json");
const endpoint = "https://dav.jianguoyun.com/dav/";
const account = String(process.env.SHENSI_NUTSTORE_ACCOUNT || "").trim();
const password = String(process.env.SHENSI_NUTSTORE_APP_PASSWORD || "");
const authorized = process.env.SHENSI_ALLOW_REAL_NUTSTORE_TEST === "1";

if (!authorized || !account || !password) {
  throw Object.assign(new Error("缺少真实坚果云验收授权或临时账号环境变量"), { code: "REAL_NUTSTORE_AUTHORIZATION_REQUIRED" });
}

const runId = `${new Date().toISOString().replace(/[-:.TZ]/gu, "")}-${randomBytes(4).toString("hex")}`;
const remoteRoot = `/ShensiAcceptance/real-${runId}/`;
if (!/^\/ShensiAcceptance\/real-[0-9]+-[0-9a-f]+\/$/u.test(remoteRoot)) {
  throw new Error("隔离远端目录校验失败");
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "shensi-nutstore-real-"));
const dataRootA = join(temporaryRoot, "device-a-data");
const dataRootB = join(temporaryRoot, "device-b-data");
const machineRootA = join(temporaryRoot, "device-a-machine");
const machineRootB = join(temporaryRoot, "device-b-machine");
const logicalPath = "作品/坚果云真实验收/往返校验.png";
const localPathA = join(dataRootA, ...logicalPath.split("/"));
const localPathB = join(dataRootB, ...logicalPath.split("/"));
const initialContent = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`shensi-initial-${runId}`, "utf8")]);
const deviceAContent = Buffer.concat([initialContent, Buffer.from("-device-a-expanded", "utf8")]);
const deviceBContent = Buffer.concat([initialContent, Buffer.from("-device-b-short", "utf8")]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const stages = [];
const assert = (condition, message, code) => {
  if (!condition) throw Object.assign(new Error(message), { code });
};
const addStage = (id, details = {}) => stages.push({ id, ok: true, ...details });
const safeError = (error) => ({
  code: String(error?.code || "REAL_NUTSTORE_ACCEPTANCE_FAILED"),
  status: Math.max(0, Number(error?.status || 0)),
  operation: String(error?.operation || "").replace(/[^A-Z]/gu, "").slice(0, 12),
  message: String(error?.message || error || "真实坚果云验收失败")
    .replaceAll(password, "[REDACTED]")
    .replaceAll(account, "[ACCOUNT]"),
});
const configFor = (deviceName) => ({ endpoint, account, password, remoteRoot, deviceName, autoSync: false });

let engineA;
let engineB;
let failure = null;
let credentialsPersisted = null;
let remoteCleanup = { attempted: false, removed: false, status: 0 };
let localCleanup = false;
let currentStage = "initializing";

try {
  await Promise.all([
    mkdir(dirname(localPathA), { recursive: true }),
    mkdir(dataRootB, { recursive: true }),
  ]);
  await writeFile(localPathA, initialContent);

  currentStage = "configure-device-a";
  engineA = createNutstoreSyncEngine({ dataRoot: dataRootA, machineRoot: machineRootA, desktopRuntime: true });
  const configuredA = await engineA.configure(configFor("Codex-真实验收-A"));
  const connection = { ok: configuredA.capabilityLevel !== "unsupported", capability: configuredA.capability };
  assert(connection.ok === true, "坚果云真实登录或 WebDAV 能力检查失败", "REAL_CONNECTION_FAILED");
  addStage("real-login-and-capability", {
    capabilityLevel: connection.capability?.capabilityLevel || "",
    ifMatch: connection.capability?.ifMatch === true,
    move: connection.capability?.move === true,
    probeCleanup: connection.capability?.cleanup === true,
  });

  currentStage = "preview-device-a";
  const previewA = await engineA.firstSyncPreview();
  assert(previewA.summary.upload >= 1, "设备 A 首次同步未产生上传计划", "REAL_UPLOAD_PLAN_MISSING");
  currentStage = "upload-device-a";
  const uploadResult = await engineA.enable({ previewToken: previewA.previewToken });
  assert(uploadResult.ok === true && uploadResult.summary.upload >= 1, "设备 A 真实上传未完成", "REAL_UPLOAD_FAILED");
  addStage("upload-from-device-a", { summary: uploadResult.summary, localSha256: sha256(initialContent) });

  currentStage = "configure-device-b";
  engineB = createNutstoreSyncEngine({
    dataRoot: dataRootB,
    machineRoot: machineRootB,
    desktopRuntime: true,
    // The same endpoint/account capability was just proven by device A.
    // Device B still performs real inventory and downloads, but reusing this
    // result avoids a second destructive capability probe in the same minute.
    capabilityProbe: async () => connection.capability,
  });
  await engineB.configure(configFor("Codex-真实验收-B"));
  currentStage = "preview-device-b";
  const previewB = await engineB.firstSyncPreview();
  assert(previewB.summary.download >= 1, "设备 B 首次同步未产生下载计划", "REAL_DOWNLOAD_PLAN_MISSING");
  currentStage = "download-device-b";
  const downloadResult = await engineB.enable({ previewToken: previewB.previewToken });
  const downloaded = await readFile(localPathB);
  assert(downloaded.equals(initialContent), "设备 B 下载内容与设备 A 上传内容不一致", "REAL_DOWNLOAD_CONTENT_MISMATCH");
  addStage("download-to-device-b", {
    summary: downloadResult.summary,
    contentMatched: true,
    downloadedSha256: sha256(downloaded),
  });

  await writeFile(localPathA, deviceAContent);
  await engineA.noteLocalChange(logicalPath);
  currentStage = "update-device-a";
  const secondUpload = await engineA.run({ reason: "real_acceptance_device_a_update" });
  if (secondUpload.summary.upload >= 1) {
    addStage("update-from-device-a", { route: "conditional_upload", summary: secondUpload.summary });
  } else {
    const deviceAConflicts = await engineA.conflicts();
    assert(
      configuredA.capabilityLevel === "safe_manual" && secondUpload.summary.conflict >= 1 && deviceAConflicts.length >= 1,
      "设备 A 更新既未安全上传，也未进入手动冲突确认",
      "REAL_CONCURRENT_UPLOAD_FAILED",
    );
    const confirmedUpdate = await engineA.resolveConflict({ conflictId: deviceAConflicts[0].id, resolution: "use_local" });
    assert(confirmedUpdate.ok === true && (await engineA.conflicts()).length === 0, "设备 A 手动确认使用本地后更新失败", "REAL_MANUAL_UPDATE_FAILED");
    addStage("update-from-device-a", { route: "safe_manual_confirmed", initialSummary: secondUpload.summary, confirmedSummary: confirmedUpdate.summary });
  }

  await writeFile(localPathB, deviceBContent);
  await engineB.noteLocalChange(logicalPath);
  currentStage = "detect-device-b-conflict";
  const conflictRun = await engineB.run({ reason: "real_acceptance_device_b_conflict" });
  const conflicts = await engineB.conflicts();
  assert(conflictRun.summary.conflict >= 1 && conflicts.length >= 1, "两设备并发修改未形成可处理冲突", "REAL_CONFLICT_NOT_DETECTED");
  assert(conflicts[0].kind === "binary", "冲突类型与验收文件不匹配", "REAL_CONFLICT_KIND_MISMATCH");
  addStage("detect-real-conflict", { summary: conflictRun.summary, conflictCount: conflicts.length, kind: conflicts[0].kind });

  currentStage = "resolve-device-b-conflict";
  const resolution = await engineB.resolveConflict({ conflictId: conflicts[0].id, resolution: "use_remote" });
  const recovered = await readFile(localPathB);
  assert(resolution.ok === true && recovered.equals(deviceAContent), "冲突选择远端版本后未恢复正确内容", "REAL_CONFLICT_RECOVERY_FAILED");
  assert((await engineB.conflicts()).length === 0, "冲突处理后仍存在未解决记录", "REAL_CONFLICT_RECORD_REMAINS");
  addStage("resolve-conflict-with-remote", { unresolvedConflicts: 0, recoveredSha256: sha256(recovered) });

  currentStage = "restart-device-b";
  const restartedB = createNutstoreSyncEngine({ dataRoot: dataRootB, machineRoot: machineRootB, desktopRuntime: true });
  const startupStatus = await restartedB.startup();
  assert(startupStatus.enabled === true && startupStatus.credentialAvailable === false, "重启状态或会话凭据边界不符合预期", "REAL_RESTART_STATE_INVALID");
  let waitingCredentialsCode = "";
  try {
    await restartedB.run({ reason: "real_acceptance_restart_without_credentials" });
  } catch (error) {
    waitingCredentialsCode = String(error?.code || "");
  }
  assert(waitingCredentialsCode === "WAITING_CREDENTIALS", "重启后未正确进入等待凭据状态", "REAL_RESTART_CREDENTIAL_GATE_MISSING");
  await restartedB.setSessionCredentials({ account, password });
  const recoveredRun = await restartedB.run({ reason: "real_acceptance_restart_recovery" });
  assert(recoveredRun.ok === true && recoveredRun.status.lastErrorCode === "", "重新提供会话凭据后同步未恢复", "REAL_RESTART_RECOVERY_FAILED");
  addStage("restart-and-recover", {
    credentialsPersistedAcrossRestart: false,
    waitingCredentialsCode,
    recoveredPhase: recoveredRun.status.phase,
    summary: recoveredRun.summary,
  });

  const statePaths = [engineA.stateStore.paths.statePath, engineA.stateStore.paths.previousPath, engineB.stateStore.paths.statePath, engineB.stateStore.paths.previousPath];
  const persistedState = (await Promise.all(statePaths.map((path) => readFile(path, "utf8").catch(() => "")))).join("\n");
  credentialsPersisted = persistedState.includes(password);
  assert(credentialsPersisted === false, "同步状态文件写入了第三方应用密码", "REAL_CREDENTIAL_PERSISTENCE_DETECTED");
  addStage("credential-persistence-audit", { passwordPersisted: false, inspectedStateFileCount: statePaths.length });
} catch (error) {
  failure = { stage: currentStage, ...safeError(error) };
  stages.push({ id: "failed-stage", ok: false, ...failure });
} finally {
  remoteCleanup.attempted = true;
  try {
    const client = createWebDavClient({ endpoint, account, password });
    const response = await client.remove(remoteRoot, { allowMissing: true });
    remoteCleanup = { attempted: true, removed: [200, 204, 404].includes(response.status), status: response.status };
  } catch (error) {
    remoteCleanup = { attempted: true, removed: false, status: 0, error: safeError(error) };
  }
  await rm(temporaryRoot, { recursive: true, force: true });
  localCleanup = true;
}

const report = {
  schemaVersion: 1,
  kind: "nutstore-real-sync",
  version: packageJson.version,
  generatedAt: new Date().toISOString(),
  ok: failure === null && remoteCleanup.removed === true && credentialsPersisted === false,
  remoteIsolation: { root: remoteRoot, cleanup: remoteCleanup },
  localIsolation: { temporaryDataRemoved: localCleanup },
  stages,
  failure,
  security: {
    credentialsPersistedByScript: false,
    passwordPersistedBySyncState: credentialsPersisted,
    passwordIncludedInEvidence: false,
  },
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: report.ok, evidence: outputPath, stages: stages.map(({ id, ok }) => ({ id, ok })), remoteCleanup, failure }));
if (!report.ok) process.exitCode = 1;
