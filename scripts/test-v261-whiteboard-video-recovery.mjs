import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  addCanvasImageNode,
  addCanvasTextNode,
  canvasNodeGenerationHistory,
  snapshotCanvasNodeVersion,
} from "../src/whiteboard.js";
import { sequencedDocumentLabel } from "../src/document-title-policy.js";
import {
  updateWhiteboardGenerationDraftCache,
  whiteboardGenerationDraftKey,
} from "../src/whiteboard-generation-draft.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = (command, args, env) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(command, args, { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", rejectRun);
  child.on("close", (code) => code === 0 ? resolveRun(stdout.trim()) : rejectRun(new Error(stderr || stdout || `exit ${code}`)));
});

let canvas = addCanvasTextNode({}, { id: "blank", text: "" });
canvas = snapshotCanvasNodeVersion(canvas, "blank");
assert.equal(canvasNodeGenerationHistory(canvas, "blank").length, 0, "空卡片不得产生历史版本");

canvas = addCanvasTextNode(canvas, { id: "story", text: "旧版故事正文" });
canvas = snapshotCanvasNodeVersion(canvas, "story", { id: "version-story-1" });
canvas = snapshotCanvasNodeVersion(canvas, "story", { id: "version-story-duplicate" });
assert.deepEqual(canvasNodeGenerationHistory(canvas, "story").map((entry) => entry.text), ["旧版故事正文"], "相同正文只保存一次");

canvas = addCanvasImageNode(canvas, { id: "image", file: "assets/old.png", name: "旧图", mimeType: "image/png" });
canvas = snapshotCanvasNodeVersion(canvas, "image", { id: "version-image-1" });
assert.equal(canvasNodeGenerationHistory(canvas, "image")[0]?.attachment?.relativePath, "assets/old.png", "上传媒体覆盖前应保存真实路径");

assert.equal(sequencedDocumentLabel({
  documentId: "chapter-2",
  title: "北灵台",
  documentState: { title: "北灵台" },
}), "第2章　北灵台");
assert.equal(sequencedDocumentLabel({
  documentId: "chapter-2",
  title: "雨夜抵达北灵台",
  documentState: { title: "雨夜抵达北灵台", customSequenceTitle: true },
}), "第2章　雨夜抵达北灵台", "章节文档必须显示章节序号和标题");
assert.equal(sequencedDocumentLabel({
  documentId: "script-episode-3",
  title: "终局直播",
  documentState: { title: "终局直播", customSequenceTitle: true },
}), "第3集　终局直播", "剧集文档必须显示集数和标题");
assert.equal(sequencedDocumentLabel({
  documentId: "imported-document",
  title: "北灵院",
  documentState: { title: "北灵院", sequenceType: "chapter", sequenceNumber: 1 },
}), "第1章　北灵院", "导入章节也必须显示章节序号和标题");
assert.equal(sequencedDocumentLabel({
  documentId: "imported-episode",
  title: "终局直播",
  documentState: { title: "终局直播", sequenceType: "episode", sequenceNumber: 3 },
}), "第3集　终局直播", "导入剧集也必须显示集数和标题");

const draftScope = { workspaceId: "workspace", documentId: "whiteboard", nodeId: "card", channel: "video" };
let draftCache = updateWhiteboardGenerationDraftCache({}, draftScope, {
  connectionId: "video-dreamina-cli-chenan",
  model: "seedance2.0",
  prompt: "newest prompt",
}, { active: false, open: false, updatedAt: 200 });
draftCache = updateWhiteboardGenerationDraftCache(draftCache, draftScope, {
  connectionId: "video-dreamina-cli-xiaoyujie",
  model: "seedance2.5",
  prompt: "older failed job",
}, { active: false, open: false, updatedAt: 100 });
assert.equal(
  draftCache.entries[whiteboardGenerationDraftKey(draftScope)]?.values.connectionId,
  "video-dreamina-cli-chenan",
  "An older failed job must not switch the current connection to Xiaoyujie",
);

const temporary = await mkdtemp(join(tmpdir(), "shensi-dreamina-status-"));
try {
  const prompt = "状态恢复测试";
  const promptPath = join(temporary, "prompt.txt");
  await writeFile(promptPath, prompt, "utf8");
  const output = await run(process.execPath, [
    join(root, "src", "cli", "dreamina-video-cli.mjs"),
    "reconcile",
    "--prompt-file", promptPath,
    "--task-type", "seedance2.5",
  ], {
    ...process.env,
    SHENSI_DREAMINA_PROFILE_ID: "default",
    SHENSI_DREAMINA_EXECUTABLE: process.execPath,
    SHENSI_DREAMINA_PREFIX_ARGS: JSON.stringify([join(root, "scripts", "fixtures", "fake-dreamina-submit-status.mjs")]),
    SHENSI_MEDIA_PROVIDER_STATE_ROOT: join(temporary, "state"),
    SHENSI_TEST_DREAMINA_PROMPT: prompt,
    SHENSI_TEST_DREAMINA_TASK_TYPE: "seedance2.5",
  });
  const payload = JSON.parse(output.split(/\r?\n/).filter(Boolean).at(-1));
  assert.equal(payload.providerStatus, "running", "即梦 submit 状态应继续跟踪，不能误判失败");
  assert.equal(payload.providerTaskId, "fixture-task-1");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

const appSource = await readFile(join(root, "src", "app.js"), "utf8");
const styles = await readFile(join(root, "src", "styles.css"), "utf8");
assert.match(appSource, /edgeTargetHandle\s*=\s*direction === "input" \? "output" : "input"/u, "多选连接应声明目标连接点方向");
assert.match(styles, /data-edge-target-handle="input"[\s\S]*whiteboard-node-handle\.input::before/u, "拖拽期间应显示已有节点输入连接点");
assert.doesNotMatch(appSource, /data-whiteboard-generation-history"\) && !canvasNodeGenerationHistory/u, "卡片历史入口不能因暂无版本而隐藏");
assert.match(appSource, /restoreInterruptedWhiteboardGenerationDraft\(job\)/u, "失败任务提示词应恢复为卡片草稿");
assert.match(appSource, /state\.workspaceKind === "notebook"[\s\S]*?semanticArtifactTarget/u, "笔记空间不得仅凭小说或剧本文体创建作品型目标");
assert.match(appSource, /state\.workspaceKind !== "notebook"\) \{/u, "跨文体作品路由必须保持在作品空间内");
assert.match(appSource, /sequencedDocumentKind\(state\.activeDocument, documentState\)/u, "正文标题应识别导入文档的章节或剧集状态");

console.log("v2.6.1 白板连接、卡片历史和即梦状态恢复测试通过");
