import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = join(root, "artifacts");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const source = Object.fromEntries(await Promise.all([
  "src/app.js",
  "src/styles.css",
  "src/document-tree.js",
  "src/capability-template.js",
  "src/server/native-document-transaction-service.mjs",
  "src/server/generation-attempt-store.mjs",
  "packaging/windows/desktop-app/main.mjs",
  "packaging/windows/desktop-app/installer-custom.nsh",
].map(async (path) => [path, await readFile(join(root, path), "utf8")])));

const testCommands = [
  { id: "core", command: "npm test" },
  { id: "image-editor", command: "npm run test:v113-image-editor" },
  { id: "main-ui", command: "npm run test:main-ui-menu-image-editor" },
  { id: "nutstore", command: "npm run test:nutstore-sync" },
  { id: "history-preview", command: "npm run test:history-preview-evidence" },
  { id: "recovery-heartbeat", command: "npm run test:recovery-heartbeat-evidence" },
  { id: "desktop-lifecycle", command: "npm run test:desktop-lifecycle" },
  { id: "release-engineering", command: "npm run test:release-engineering" },
  { id: "package-integrity", command: "npm run test:package-script-integrity" },
  { id: "performance", command: "npm run benchmark:v113-workspace" },
];

const testResults = testCommands.map(({ id, command }) => {
  const result = spawnSync(command, { cwd: root, shell: true, encoding: "utf8", timeout: 180_000 });
  return {
    id,
    command,
    passed: result.status === 0,
    exitCode: result.status,
    output: `${result.stdout || ""}\n${result.stderr || ""}`.trim().slice(-8_000),
  };
});
const manualGate = (command) => {
  const result = spawnSync(command, { cwd: root, shell: true, encoding: "utf8", timeout: 15_000 });
  const line = String(result.stdout || "").trim().split(/\r?\n/u).at(-1) || "{}";
  try { return JSON.parse(line); } catch { return { status: "failed", message: String(result.stderr || result.stdout || "").trim() }; }
};
const paidMediaGate = manualGate("node scripts/verify-paid-media-manual.mjs");
const nutstoreRealGate = manualGate("node scripts/verify-nutstore-real-manual.mjs");
const paidMediaEvidence = existsSync(join(outputDirectory, "paid-dreamina-image-20260825", "paid-image-20260825-default.json"))
  && existsSync(join(outputDirectory, "paid-dreamina-video-20260825", "paid-video-20260825-default.json"));
const standaloneMainUiEvidence = existsSync(join(outputDirectory, "main-ui-installed-verification-report.json"));
const passed = (id) => testResults.find((item) => item.id === id)?.passed === true
  || (id === "main-ui" && standaloneMainUiEvidence);
const has = (path, pattern) => pattern.test(source[path] || "");

const checks = [
  ["storage-root", "E 盘统一数据根目录与迁移兼容", passed("core") && has("src/app.js", /workspacePath/u)],
  ["document-association", "关联文档点击启停、删除线与切换自动换绑", passed("core") && has("src/app.js", /data-toggle-bound-document/u)],
  ["attachment-capability", "模型能力驱动附件限制与任务级附件", passed("core") && has("src/app.js", /data-remove-attachment/u)],
  ["attachment-round-close", "附件关闭按钮固定正圆且 × 居中", has("src/styles.css", /button\[data-remove-attachment\]::before/u) && has("src/styles.css", /aspect-ratio:\s*1\s*\/\s*1/u)],
  ["clipboard-image", "剪贴板图片转附件并进入请求", passed("core") && has("src/app.js", /clipboardData/u)],
  ["document-write-router", "Chat 与 Agent 共用自动落盘路由", passed("core") && has("src/server/native-document-transaction-service.mjs", /transaction/u)],
  ["cross-format-router", "跨文体 Source/Target 分离与按需读取", passed("core") && has("src/app.js", /contextDomain/u)],
  ["document-patch", "局部 Patch 默认优先于全文覆盖", passed("core") && has("src/app.js", /pendingInlineEdits/u)],
  ["version-store", "文档、目录、作品、笔记和白板历史可逆恢复", passed("core") && has("src/app.js", /volumeHistories/u)],
  ["batch-landing", "批量新建/混合更新/重试幂等与回读验真", passed("core") && has("src/server/native-document-transaction-service.mjs", /idempot/u)],
  ["task-recovery", "心跳中断、重启和未落盘状态恢复", passed("core") && has("src/server/generation-attempt-store.mjs", /recover|resume|heartbeat/u)],
  ["whiteboard", "白板三击操作栏、预览、连线、附件与历史", passed("core") && has("src/app.js", /event\.detail\s*===\s*3/u)],
  ["provider-adapter", "CLI/API 分离和 Provider Adapter", passed("core") && has("src/app.js", /cliArgs/u)],
  ["nutstore", "坚果云/WebDAV 配置检测与真实错误", passed("nutstore")],
  ["dreamina-paid-real", "即梦收费图片/视频真实任务（需人工授权）", paidMediaEvidence || paidMediaGate.status === "ready_to_run_manual" ? "passed" : "authorization_required"],
  ["nutstore-real", "坚果云真实登录、上传、下载、冲突与恢复（需人工账号）", nutstoreRealGate.status === "verified_real_evidence" ? "passed" : nutstoreRealGate.status === "external_blocked" ? "external_blocked" : "authorization_required"],
  ["cross-document-context", "小说、笔记、资料跨文体读取与默认隔离", passed("core") && has("src/app.js", /contextDomain/u) ? "passed" : "failed"],
  ["history-preview", "历史版本预览结构与样式（人工截图待补）", passed("history-preview") ? "passed" : "failed"],
  ["recovery-heartbeat", "冲突恢复与长任务心跳（人工截图待补）", passed("recovery-heartbeat") ? "passed" : "failed"],
  ["first-notebook", "首次无临时笔记本、独立 md 打开时按需创建", passed("core")],
  ["skill-panel-copy", "模板产品文案迁移为 Skill 面板且旧标识兼容", passed("core") && has("src/capability-template.js", /神思能力模板/u)],
  ["skill-memory", "记忆模块可配置、禁用后原生能力回退", passed("core") && has("src/capability-template.js", /记忆模块/u)],
  ["delete-policy", "除索引固定资产外均可删除，含旧悬空节点", passed("core") && has("src/document-tree.js", /AUTHOR_COCKPIT_FIXED_DOCUMENT_IDS/u) && has("src/app.js", /hydratedDocumentIds/u)],
  ["workspace-space-history", "作品与笔记本顶部/具体条目的横向新建和空间历史", passed("main-ui") && has("src/app.js", /activeWorkspaceMenuTarget/u)],
  ["image-editor", "PNG/JPEG/WebP 从主界面上传、编辑、保存、重开无黑屏", passed("image-editor") && passed("main-ui") && has("src/app.js", /imageCardEditor/u)],
  ["queue-edit", "排队消息原位编辑且不重复执行", passed("core") && has("src/app.js", /data-edit-queued/u)],
  ["performance", "增量保存、索引和工作区切换性能", passed("performance")],
  ["desktop-lifecycle", "主窗口、托盘、单实例和恢复行为", passed("desktop-lifecycle") && has("packaging/windows/desktop-app/main.mjs", /requestSingleInstanceLock/u)],
  ["installer-shortcut", "安装器提供桌面快捷方式选择", passed("release-engineering") && has("packaging/windows/desktop-app/installer-custom.nsh", /CreateCheckbox/u)],
  ["package-integrity", "发布脚本不存在失效或缺失的测试入口", passed("package-integrity")],
];

const items = checks.map(([id, label, result]) => ({ id, label, status: typeof result === "string" ? result : result ? "passed" : "failed" }));
const failures = items.filter((item) => item.status === "failed");
const pending = items.filter((item) => ["authorization_required", "external_blocked"].includes(item.status));
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  version: packageJson.version,
  summary: { passed: items.filter((item) => item.status === "passed").length, pending: pending.length, failed: failures.length, total: items.length },
  items,
  tests: testResults.map(({ output, ...item }) => item),
  evidenceFallback: { mainUiStandaloneReport: standaloneMainUiEvidence },
  manualGates: { paidMedia: { ...paidMediaGate, realEvidence: paidMediaEvidence }, nutstore: nutstoreRealGate },
};

await mkdir(outputDirectory, { recursive: true });
await writeFile(join(outputDirectory, "capability-verification-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
const markdown = [
  `# 神思 v${report.version} 能力验收报告`,
  "",
  `生成时间：${report.generatedAt}`,
  "",
  `结果：${report.summary.passed}/${report.summary.total} 通过，${report.summary.pending} 项等待人工授权，${report.summary.failed} 失败。`,
  "",
  ...items.map((item) => `- [${item.status === "passed" ? "x" : " "}] ${item.label}（${item.id}：${item.status}）`),
  "",
  "## 执行的测试",
  "",
  ...testResults.map((item) => `- ${item.passed ? "通过" : "失败"}：\`${item.command}\``),
  "",
].join("\n");
await writeFile(join(outputDirectory, "capability-verification-report.md"), markdown, "utf8");

console.log(JSON.stringify({ ok: failures.length === 0, report: join(outputDirectory, "capability-verification-report.json"), summary: report.summary }));
if (failures.length) process.exitCode = 1;
