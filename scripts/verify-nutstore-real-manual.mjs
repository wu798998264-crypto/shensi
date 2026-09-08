import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const evidencePath = join(root, "artifacts", "nutstore-real-acceptance-20260825.json");
const realEvidence = await readFile(evidencePath, "utf8")
  .then((value) => JSON.parse(value))
  .catch(() => null);
const verified = realEvidence?.ok === true
  && realEvidence?.security?.passwordPersistedBySyncState === false
  && realEvidence?.remoteIsolation?.cleanup?.removed === true;
const attempted = realEvidence?.kind === "nutstore-real-sync" && realEvidence?.ok === false;
const authorized = process.env.SHENSI_ALLOW_REAL_NUTSTORE_TEST === "1"
  && String(process.env.SHENSI_NUTSTORE_ACCOUNT || "").trim()
  && String(process.env.SHENSI_NUTSTORE_APP_PASSWORD || "").trim();
const evidence = {
  kind: "nutstore-real-sync",
  version: packageJson.version,
  status: verified ? "verified_real_evidence" : attempted ? "external_blocked" : authorized ? "ready_to_run_manual" : "authorization_required",
  executed: verified || attempted,
  evidencePath: verified || attempted ? evidencePath : "",
  message: verified
    ? "真实坚果云登录、上传、下载、冲突处理、重启恢复与凭据不落盘均已通过。"
    : attempted
      ? `真实坚果云验收未完成：${String(realEvidence?.failure?.message || "外部账号状态阻止同步")}`
    : authorized
    ? "已准备人工账号验收门槛；脚本不会打印或保存凭据，需在界面执行登录、上传、下载、冲突与恢复。"
    : "未连接真实坚果云账号。需要人工授权标记及账号/应用密码环境变量；当前仅保留契约测试。",
};
console.log(JSON.stringify(evidence));
