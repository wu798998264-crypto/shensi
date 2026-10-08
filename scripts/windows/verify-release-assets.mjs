import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This command is deliberately a local guard, not an uploader.  CI or the
// release operator must call it immediately before uploading so an arbitrary
// file cannot be substituted for the signed installer assets.
const planPath = resolve(process.argv[2] || await latestPlanPath());
const plan = JSON.parse(await readFile(planPath, "utf8"));
if (![1, 2].includes(Number(plan.schemaVersion))) throw new Error("发布资产计划版本不受支持");
if (plan.uploadPerformed === true) throw new Error("资产计划已标记为已上传，禁止重复使用");
const details = Array.isArray(plan.assetDetails) ? plan.assetDetails : (plan.assets || []).map((path) => ({ path }));
if (details.length !== 3) throw new Error("发布资产计划必须且只能包含安装包、校验和、签名清单三项");
const kinds = new Set(details.map((item) => String(item.kind || "")));
if (kinds.size === 3 && !["installer", "checksum", "manifest"].every((kind) => kinds.has(kind))) throw new Error("发布资产类型不完整");
const expectedNames = new Set(["installer", "checksum", "manifest"]);
const seenNames = new Set();
for (const item of details) {
  const path = resolve(String(item.path || ""));
  const name = basename(path);
  if (!path || !name || seenNames.has(name)) throw new Error("发布资产路径为空或重复");
  seenNames.add(name);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error(`发布资产不存在：${name}`);
  const bytes = await readFile(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (Number(item.sizeBytes) !== bytes.length || String(item.sha256 || "").toLowerCase() !== sha256) {
    throw new Error(`发布资产大小或 SHA-256 不一致：${name}`);
  }
  if (item.name && String(item.name) !== name) throw new Error(`发布资产名称不一致：${name}`);
  if (item.kind && !expectedNames.has(String(item.kind))) throw new Error(`发布资产类型未授权：${item.kind}`);
}
if (kinds.size === 3 && ![...expectedNames].every((kind) => kinds.has(kind))) throw new Error("发布资产计划缺少必要类型");
console.log(JSON.stringify({ ok: true, plan: planPath, assets: details.map((item) => ({ name: basename(item.path), kind: item.kind || "legacy" })) }));

async function latestPlanPath() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const base = resolve(root, "release", "github");
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  const candidates = entries.filter((entry) => entry.isDirectory()).map((entry) => resolve(base, entry.name, "release-assets.json"));
  for (const candidate of candidates.sort().reverse()) {
    if (await stat(candidate).then(() => true).catch(() => false)) return candidate;
  }
  throw new Error("未找到 release-assets.json；请先运行发布准备脚本");
}
