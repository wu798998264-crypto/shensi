import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createVerifiedDataSnapshot } from "../src/server/update-data-guard.mjs";

const [targetVersion, reportArgument, ...roots] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/u.test(targetVersion || "") || !reportArgument || !roots.length) {
  throw new Error("usage: snapshot-release-user-data <version> <local-report> <explicit-data-root> ...");
}
const reportPath = resolve(reportArgument);
const reports = [];
for (const root of roots) {
  const dataRoot = resolve(root);
  if (dataRoot === resolve(dataRoot, "..")) throw new Error("拒绝备份磁盘根目录");
  console.log(JSON.stringify({ phase: "snapshot-start", dataRoot }));
  const snapshot = await createVerifiedDataSnapshot({ dataRoot, targetVersion, operation: "release-preflight" });
  reports.push({ dataRoot, snapshotRoot: snapshot.snapshotRoot, snapshotDataRoot: snapshot.snapshotDataRoot,
    createdAt: snapshot.manifest.createdAt, files: snapshot.manifest.inventory.files.length,
    bytes: snapshot.manifest.inventory.totalBytes, verified: true });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ targetVersion, snapshots: reports }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ phase: "snapshot-verified", ...reports.at(-1) }));
}
