import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  markPreparedUpdateInstallerState,
  rollbackPreparedUserDataUpdate,
} from "../src/server/update-data-guard.mjs";

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const processIsAlive = (pid) => {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

const waitForParentExit = async (pid, { timeoutMs = 120_000 } = {}) => {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return;
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid)) {
    if (Date.now() >= deadline) throw new Error("等待旧版本进程退出超时");
    await delay(200);
  }
};

const runProcess = ({ executable, args, env }) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(executable, args, {
    env,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  child.once("error", rejectRun);
  child.once("exit", (code, signal) => resolveRun({ code: Number.isInteger(code) ? code : -1, signal: String(signal || "") }));
});

export const runInstallerUpdateTransaction = async ({
  installerPath,
  installerArgs = [],
  dataRoot,
  transactionId,
  parentPid = 0,
  helperPid = process.pid,
} = {}) => {
  if (!installerPath || !dataRoot || !transactionId) throw new Error("安装器 helper 缺少事务参数");
  await markPreparedUpdateInstallerState({
    dataRoot,
    transactionId,
    phase: "installer_running",
    installerPid: helperPid,
    detail: { parentPid: Number(parentPid) || 0 },
  });
  try {
    await waitForParentExit(parentPid);
    const dataArgument = `/SHENSIDATAROOT=${dataRoot}`;
    const args = [...installerArgs.map(String)];
    if (!args.some((value) => /^\/SHENSIDATAROOT=/i.test(value))) args.push(dataArgument);
    const result = await runProcess({
      executable: installerPath,
      args,
      env: { ...process.env, SHENSI_DATA_ROOT: dataRoot },
    });
    if (result.code !== 0) {
      const error = new Error(`安装器退出码为 ${result.code}${result.signal ? `（${result.signal}）` : ""}`);
      error.code = "UPDATE_INSTALLER_EXIT_FAILED";
      throw error;
    }
    await markPreparedUpdateInstallerState({
      dataRoot,
      transactionId,
      phase: "installer_succeeded",
      detail: { exitCode: result.code },
    });
    return { installed: true, exitCode: result.code };
  } catch (error) {
    const rollback = await rollbackPreparedUserDataUpdate({
      dataRoot,
      transactionId,
      reason: error?.code || "installer-failed",
    });
    const wrapped = new Error(`安装失败，用户数据已恢复：${error.message}`);
    wrapped.code = error?.code || "UPDATE_INSTALLER_FAILED";
    wrapped.rollback = rollback;
    throw wrapped;
  }
};

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const installerPath = String(process.env.SHENSI_UPDATE_INSTALLER || "");
  const dataRoot = String(process.env.SHENSI_UPDATE_DATA_ROOT || "");
  const transactionId = String(process.env.SHENSI_UPDATE_TRANSACTION_ID || "");
  const parentPid = Number(process.env.SHENSI_UPDATE_PARENT_PID) || 0;
  let installerArgs = [];
  try { installerArgs = JSON.parse(process.env.SHENSI_UPDATE_INSTALLER_ARGS_JSON || "[]"); } catch {}
  await runInstallerUpdateTransaction({ installerPath, installerArgs, dataRoot, transactionId, parentPid });
}
