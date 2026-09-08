import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { appDataRoot, setConfiguredDataRoot } from "../app-data.mjs";
import { applyStorageRootChange, previewStorageRootChange } from "../storage-manager.mjs";

const cloudPattern = /(?:坚果云|Nutstore|Nutshell|百度网盘|BaiduNetdisk|BaiduSyncdisk)/i;

export const createNutstoreMigrationManager = ({ machineRoot, syncEngine }) => {
  const migrationRoot = join(resolve(machineRoot), "machine-sessions", "nutstore-sync-v1", "migration");
  const recordPath = join(migrationRoot, "latest.json");
  const readRecord = async () => { try { return JSON.parse(await readFile(recordPath, "utf8")); } catch { return null; } };
  const writeRecord = async (value) => { await mkdir(migrationRoot, { recursive: true }); await writeFile(recordPath, `${JSON.stringify(value, null, 2)}\n`, "utf8"); return value; };
  const preview = async ({ targetRoot, userConfirmedClientSync = false } = {}) => {
    const currentRoot = appDataRoot();
    const storage = await previewStorageRootChange({ targetRoot });
    return {
      migrationId: randomUUID(), currentRoot, targetRoot: storage.targetRoot, suspectedNutstoreFolder: cloudPattern.test(currentRoot),
      userConfirmationRequired: cloudPattern.test(currentRoot) && userConfirmedClientSync !== true,
      mustPauseDesktopClient: cloudPattern.test(currentRoot), storage,
      steps: ["保存全部工作区", "建立可验证迁移记录", "事务复制并校验", "切换本地私有目录", "保留旧目录", "配置 WebDAV 并执行首次同步预览"],
    };
  };
  const apply = async ({ targetRoot, currentWorkspacePath = "", userConfirmedClientSync = false } = {}) => {
    const plan = await preview({ targetRoot, userConfirmedClientSync });
    if (plan.userConfirmationRequired) throw Object.assign(new Error("请先确认当前目录是否由坚果云客户端同步，并暂停客户端同步"), { code: "MIGRATION_CONFIRMATION_REQUIRED" });
    const record = await writeRecord({ schemaVersion: 1, migrationId: plan.migrationId, status: "applying", originalRoot: plan.currentRoot, targetRoot: plan.targetRoot, createdAt: new Date().toISOString(), oldDirectoryPreserved: true, storagePreview: plan.storage });
    try {
      const applied = await applyStorageRootChange({ targetRoot: plan.targetRoot, currentWorkspacePath });
      syncEngine.setDataRoot(applied.root);
      record.status = "local_migration_completed";
      record.appliedAt = new Date().toISOString();
      record.result = applied;
      record.requiresFirstSyncValidation = true;
      await writeRecord(record);
      return record;
    } catch (error) {
      await setConfiguredDataRoot(record.originalRoot).catch(() => {});
      syncEngine.setDataRoot(record.originalRoot);
      record.status = "rolled_back";
      record.failedAt = new Date().toISOString();
      record.errorCode = String(error?.code || "MIGRATION_FAILED");
      await writeRecord(record);
      throw error;
    }
  };
  const rollback = async () => {
    const record = await readRecord();
    if (!record?.originalRoot) throw Object.assign(new Error("没有可回滚的坚果云旧方式迁移"), { code: "MIGRATION_ROLLBACK_UNAVAILABLE" });
    await setConfiguredDataRoot(record.originalRoot);
    syncEngine.setDataRoot(record.originalRoot);
    record.status = "rolled_back";
    record.rolledBackAt = new Date().toISOString();
    await writeRecord(record);
    return record;
  };
  return { preview, apply, rollback, readRecord, paths: { migrationRoot, recordPath } };
};

