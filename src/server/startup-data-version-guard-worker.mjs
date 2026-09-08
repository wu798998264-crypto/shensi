import { resolve } from "node:path";
import { appDataRoot, initializeConfiguredDataRoot, machineLocalDataRoot } from "./app-data.mjs";
import { guardDesktopStartupDataVersion } from "./update-data-guard.mjs";
import { migrateAllLegacyWorkspacesToPersistent, migrateAllManagedWorkspaceHistoryIndexes } from "./workspace.mjs";

const samePath = (left, right) => {
  const a = resolve(String(left || ""));
  const b = resolve(String(right || ""));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
};

try {
  const encoded = String(process.env.SHENSI_STARTUP_GUARD_INPUT || "");
  delete process.env.SHENSI_STARTUP_GUARD_INPUT;
  const input = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (input?.protocolVersion !== 1) throw Object.assign(new Error("启动数据保护协议不受支持"), { code: "STARTUP_DATA_GUARD_PROTOCOL" });
  await initializeConfiguredDataRoot();
  if (!samePath(input.dataRoot, appDataRoot()) || !samePath(input.machineRoot, machineLocalDataRoot())) {
    throw Object.assign(new Error("启动数据保护目录身份不一致"), { code: "STARTUP_DATA_GUARD_ROOT_MISMATCH" });
  }
  const result = await guardDesktopStartupDataVersion({
    dataRoot: input.dataRoot,
    machineRoot: input.machineRoot,
    currentVersion: input.currentVersion,
    buildId: input.buildId,
    dataSchemaVersion: input.dataSchemaVersion,
    migrate: async () => {
      const legacyWorkspaces = await migrateAllLegacyWorkspacesToPersistent({ appRoot: input.appRoot });
      const historyIndexes = await migrateAllManagedWorkspaceHistoryIndexes({ appRoot: input.appRoot });
      return {
        migrated: Number(legacyWorkspaces.migrated || 0) + Number(historyIndexes.migrated || 0),
        legacyWorkspaceCount: Number(legacyWorkspaces.migrated || 0),
        historyIndexes,
      };
    },
  });
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stderr.write(JSON.stringify({
    ok: false,
    code: String(error?.code || "STARTUP_DATA_GUARD_FAILED"),
    message: String(error?.message || error).slice(0, 4_000),
  }));
  process.exitCode = 1;
}
