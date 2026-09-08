import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const root = fileURLToPath(new URL("..", import.meta.url));
const realEvidence = existsSync(join(root, "artifacts", "paid-dreamina-image-20260825", "paid-image-20260825-default.json"))
  && existsSync(join(root, "artifacts", "paid-dreamina-video-20260825", "paid-video-20260825-default.json"));
const authorized = process.env.SHENSI_ALLOW_PAID_SMOKE_TEST === "1"
  && process.env.SHENSI_PAID_MEDIA_CONFIRMATION === "I_UNDERSTAND_CHARGES"
  && String(process.env.SHENSI_DREAMINA_PROFILE_ID || "").trim();
const evidence = {
  kind: "dreamina-paid-media",
  version: packageJson.version,
  status: realEvidence ? "verified_real_evidence" : authorized ? "ready_to_run_manual" : "authorization_required",
  executed: realEvidence,
  message: realEvidence
    ? "已找到本次人工授权产生的图片与 4 秒视频回执。"
    : authorized
    ? "已获得人工授权门槛；脚本仍不会自动提交收费图片/视频，需在神思界面逐项点击并保存回执。"
    : "未执行收费任务。需要 SHENSI_ALLOW_PAID_SMOKE_TEST=1、确认收费字符串和具体配置 ID。",
};
console.log(JSON.stringify(evidence));
