import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const destination = process.argv[2];
if (!destination) throw new Error("必须指定私有本地备份目录");
const sources = [
  join(homedir(), "AppData/Local/ShensiCreativeEngine-DesktopRuntime/Session/Local Storage/leveldb"),
  "E:/ShensiUserData/recovery/workspace-checkpoints",
];
const report = [];
for (const [index, source] of sources.entries()) {
  const files = (await readdir(source, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name !== "LOCK");
  const selected = index === 0 ? files : (await Promise.all(files.map(async entry => ({ entry, modified: (await stat(join(source, entry.name))).mtimeMs })))).sort((a, b) => b.modified - a.modified).slice(0, 4).map(item => item.entry);
  const target = join(destination, index === 0 ? "browser-storage" : "recent-checkpoints");
  await mkdir(target, { recursive: true });
  for (const file of selected) {
    try { await copyFile(join(source, file.name), join(target, file.name)); report.push({ name: file.name, copied: true }); }
    catch (error) { report.push({ name: file.name, copied: false, error: error.code }); }
  }
}
await writeFile(join(destination, "backup-report.json"), JSON.stringify(report));
console.log(JSON.stringify({ destination, copied: report.filter(item => item.copied).length, failed: report.filter(item => !item.copied), note: "仅备份已持久化缓存；未刷新或退出用户页面" }));
