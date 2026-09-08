import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDataRoot = await mkdtemp(join(tmpdir(), "shensi-recovery-overlay-"));
process.env.SHENSI_DATA_ROOT = temporaryDataRoot;

try {
  const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(
    appSource,
    /const recoveryDocumentOverlayState = \(documentIds\) => \{[\s\S]{0,900}workspaceStatePayload\(\{ documents \}\)\.documents;/u,
    "快速恢复必须只规范化本轮变更文档",
  );
  assert.match(
    appSource,
    /const recoveryState = Array\.isArray\(recoveryDocumentIds\)[\s\S]{0,700}compactRecoveryState\(stateForWorkspace\(\)\);/u,
    "只有未知范围变更才能回退到完整工作区恢复状态",
  );
  assert.match(appSource, /protected: \{[^\n]+编辑内容已实时保护/u, "实时保护成功必须向用户显示明确状态");
  assert.match(
    appSource,
    /const persist = \(\{[\s\S]{0,240}deferCompilationStatus = false,[\s\S]{0,160}skipRecoveryCheckpoint = false/u,
    "编辑热路径必须能将非关键元数据排除在快速恢复检查点之外",
  );
  assert.match(
    appSource,
    /persist\(\{ documentIds: \[documentId\], deferCompilationStatus: true \}\);/u,
    "正文输入必须推迟项目总览的全工作区统计",
  );
  assert.match(
    appSource,
    /recordActivity\(\{ type: "edit", label: `编辑\$\{state\.documents\[documentId\][\s\S]{0,700}persist\(\{ skipContextCompaction: true, skipRecoveryCheckpoint: true \}\);/u,
    "编辑活动元数据不得重复制造完整恢复检查点",
  );
  assert.doesNotMatch(appSource, /setInterval\(refreshExecutionTimers, 250\)/u, "空闲界面不得永久扫描任务计时 DOM");
  assert.match(
    appSource,
    /const scheduleExecutionTimerRefresh = \(\) => \{[\s\S]{0,700}document\.querySelector\(EXECUTION_TIMER_SELECTOR\)/u,
    "任务计时刷新必须只在存在活动任务节点时启动",
  );
  assert.match(
    appSource,
    /const serializableEditorSnapshot = \(\) => \{[\s\S]{0,1600}return \{ html, text \};[\s\S]{0,220}serializableEditorSnapshot\(\)\.html/u,
    "长文输入必须复用同一份安全清洗快照",
  );
  assert.match(
    appSource,
    /cachedPreviousText\?\.revision === previousRevision[\s\S]{0,300}serializableEditorSnapshot\(\)/u,
    "连续输入不得重复清洗上一版完整正文",
  );

  const {
    commitWorkspaceRecoveryCheckpoint,
    loadWorkspaceRecoveryCheckpoint,
    saveWorkspaceRecoveryCheckpoint,
  } = await import("../src/server/recovery-store.mjs");
  const { restoreRecoveryState } = await import("../src/recovery-checkpoint.js");
  const workspacePath = join(temporaryDataRoot, "作品", "恢复协议测试");
  const clientId = "recovery-overlay-test-client";
  const checkpoint = await saveWorkspaceRecoveryCheckpoint({
    workspacePath,
    workspaceKind: "project",
    projectName: "恢复协议测试",
    clientId,
    revision: 7,
    baseSavedAt: "2026-08-28T00:00:00.000Z",
    stateMode: "document-overlay-v2",
    documentIds: ["chapter-1", "chapter-deleted", "chapter-1"],
    state: {
      documents: {
        "chapter-1": { title: "第一章", html: "<p>实时保护后的正文</p>" },
      },
      settings: { apiKey: "must-not-be-stored" },
    },
  });

  assert.equal(checkpoint.stateMode, "document-overlay-v2");
  assert.deepEqual(checkpoint.documentIds, ["chapter-1", "chapter-deleted"]);
  assert.equal(checkpoint.state.settings?.apiKey, undefined);

  const loaded = await loadWorkspaceRecoveryCheckpoint({ workspacePath, clientId });
  assert.equal(loaded.stateMode, "document-overlay-v2");
  assert.deepEqual(loaded.documentIds, ["chapter-1", "chapter-deleted"]);

  const restored = restoreRecoveryState({
    canonicalState: {
      projectName: "恢复协议测试",
      documents: {
        "chapter-1": { title: "第一章", html: "<p>磁盘旧正文</p>" },
        "chapter-2": { title: "第二章", html: "<p>不应被覆盖</p>" },
        "chapter-deleted": { title: "待删除章节", html: "<p>已删除</p>" },
      },
    },
    checkpoint: loaded,
  });
  assert.equal(restored.documents["chapter-1"].html, "<p>实时保护后的正文</p>");
  assert.equal(restored.documents["chapter-2"].html, "<p>不应被覆盖</p>");
  assert.equal(restored.documents["chapter-deleted"], undefined);

  const committed = await commitWorkspaceRecoveryCheckpoint({ workspacePath, clientId, revision: 7 });
  assert.equal(committed.dirty, false);
  assert.equal(committed.stateMode, "document-overlay-v2");
  assert.deepEqual(committed.documentIds, ["chapter-1", "chapter-deleted"]);

  const port = 43_000 + (process.pid % 1_000);
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs", "--port", String(port)], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, SHENSI_DATA_ROOT: temporaryDataRoot },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  server.stdout.on("data", (chunk) => { serverOutput += String(chunk); });
  server.stderr.on("data", (chunk) => { serverOutput += String(chunk); });
  try {
    let index = "";
    for (let attempt = 0; attempt < 60 && !index; attempt += 1) {
      try {
        const response = await fetch(`${origin}/`);
        if (response.ok) index = await response.text();
      } catch {}
      if (!index) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(index, `恢复协议测试服务未启动：${serverOutput.slice(-600)}`);
    const token = index.match(/name="shensi-session-token" content="([^"]+)"/)?.[1];
    assert.ok(token, "恢复协议 HTTP 测试必须取得会话令牌");
    const headers = { "content-type": "application/json", origin, "x-shensi-session": token };
    const httpClientId = "recovery-overlay-http-client";
    const response = await fetch(`${origin}/api/recovery/checkpoint`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspacePath,
        workspaceKind: "project",
        projectName: "恢复协议测试",
        clientId: httpClientId,
        revision: 11,
        stateMode: "document-overlay-v2",
        documentIds: ["chapter-2"],
        state: { documents: { "chapter-2": { title: "第二章", html: "<p>HTTP 增量正文</p>" } } },
      }),
    });
    const responsePayload = await response.json();
    assert.equal(response.ok, true, responsePayload.message || "HTTP 检查点写入失败");
    const loadedResponse = await fetch(`${origin}/api/recovery/checkpoint?workspacePath=${encodeURIComponent(workspacePath)}&clientId=${encodeURIComponent(httpClientId)}`, { headers });
    const loadedPayload = await loadedResponse.json();
    assert.equal(loadedResponse.ok, true);
    assert.equal(loadedPayload.checkpoint.stateMode, "document-overlay-v2");
    assert.deepEqual(loadedPayload.checkpoint.documentIds, ["chapter-2"]);
    assert.equal(loadedPayload.checkpoint.state.documents["chapter-2"].html, "<p>HTTP 增量正文</p>");
  } finally {
    server.kill();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log("recovery document overlay protocol tests passed");
} finally {
  await rm(temporaryDataRoot, { recursive: true, force: true });
}
