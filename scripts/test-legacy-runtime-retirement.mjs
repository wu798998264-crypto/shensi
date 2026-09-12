import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleRoot = path.join(repoRoot, "packaging", "bundled", "skill", "神思");

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["_备份_不参与规则扫描", "原始资料", "废弃设定"].includes(entry.name)) return [];
      return markdownFiles(absolute);
    }
    return entry.isFile() && entry.name.endsWith(".md") ? [absolute] : [];
  }));
  return nested.flat();
}

const retiredFiles = [
  "神思-双核运行规则.md",
  "神思-创作核运行卡.md",
  "神思-记忆核运行卡.md",
  "神思-分级闭环与规则包规则.md",
  "神思-正文创作核心卡.md",
];
const files = await markdownFiles(bundleRoot);
const basenames = new Set(files.map((file) => path.basename(file)));
for (const retired of retiredFiles) assert.equal(basenames.has(retired), false, `retired file still bundled: ${retired}`);

const combined = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
for (const [label, pattern] of [
  ["双核", /双核/u],
  ["创作核", /创作核(?!心)/u],
  ["记忆核", /记忆核/u],
  ["动态创作胶囊", /动态创作胶囊/u],
]) {
  assert.doesNotMatch(combined, pattern, `retired runtime contract still referenced: ${label}`);
}
for (const pattern of [
  /AI\s*首轮.{0,24}默认.{0,12}不(?:自动)?落盘/u,
  /轻微修改.{0,24}可不备份/u,
  /关键词命中.{0,30}(?:固定|直接).{0,12}(?:Skill|任务)/u,
  /唯一主笔/u,
]) {
  assert.doesNotMatch(combined, pattern);
}

const runtimeContract = await readFile(path.join(bundleRoot, "神思模块", "神思运行规范.md"), "utf8");
assert.match(runtimeContract, /正式内容.{0,40}(?:直接写入|自动落盘)/u);
assert.match(runtimeContract, /完整可恢复历史版本/u);
assert.match(runtimeContract, /真实工具回执/u);

const healthContract = await readFile(path.join(bundleRoot, "神思模块", "规则模块", "神思-框架健康检查规则.md"), "utf8");
assert.match(healthContract, /“已读取”位于生成任务卡内部的最下方/u);
assert.match(healthContract, /文档对话只进入 Conversation Agent/u);
assert.match(healthContract, /白板和媒体只进入白板\/媒体 API/u);

console.log("legacy runtime retirement contracts passed");
