import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBlankNotebookState } from "../src/data.js";
import { loadWorkspaceState, saveWorkspaceState } from "../src/server/workspace.mjs";

const temporaryRoot = await mkdtemp(join(tmpdir(), "shensi-commit-integrity-"));
const appRoot = join(temporaryRoot, "app");
const requestedPath = join(appRoot, "runtime", "E-drive-data", "笔记", "发布一致性验收");
const options = { appRoot, requestedPath };
const internalRoot = join(requestedPath, ".shensi");
const paths = {
  current: join(internalRoot, "current-state.json"),
  history: join(internalRoot, "history-isolated", "index.json"),
  marker: join(internalRoot, "commit.json"),
};
const originalFiles = {};
try {
  const state = createBlankNotebookState({ name: "发布一致性验收" });
  state.documents = {
    "note-a": { title: "验收文档", html: "<p>最新正文，不得回退</p>", moduleId: "library" },
    "board-a": { title: "验收白板", kind: "whiteboard", moduleId: "library", whiteboard: { nodes: [], edges: [] } },
  };
  state.moduleItems.library = [["note-a", "验收文档"], ["board-a", "验收白板"]];
  state.histories = { "note-a": [{ id: "history-a", document: { ...state.documents["note-a"], html: "<p>历史正文</p>" } }] };
  await saveWorkspaceState({ ...options, state });
  assert.equal((await loadWorkspaceState(options)).state.documents["note-a"].title, "验收文档");
  for (const [name, path] of Object.entries(paths)) originalFiles[name] = await readFile(path, "utf8");

  for (const [name, field] of [["history", "workspaceCommitId"], ["marker", "commitId"], ["current", "workspaceCommitId"]]) {
    const altered = JSON.parse(originalFiles[name]);
    altered[field] = "TEST_DIFFERENT_COMMIT";
    await writeFile(paths[name], JSON.stringify(altered));
    await assert.rejects(loadWorkspaceState(options), (error) => error.code === "WORKSPACE_COMMIT_MISMATCH" && error.statusCode === 409,
      `${name} 与发布标记不一致时必须拒绝混合版本`);
    assert.equal(await readFile(paths[name], "utf8"), JSON.stringify(altered), "拒绝加载不得修复、覆盖或回退磁盘原件");
    await writeFile(paths[name], originalFiles[name]);
  }

  await rm(paths.marker);
  await assert.rejects(loadWorkspaceState(options), { code: "WORKSPACE_COMMIT_MISMATCH" }, "新格式缺失发布标记不得作为旧格式加载");
  await writeFile(paths.marker, originalFiles.marker);

  // Old workspaces remain readable only when all publication IDs are absent.
  for (const name of ["current", "history"]) {
    const legacy = JSON.parse(originalFiles[name]);
    delete legacy.workspaceCommitId;
    await writeFile(paths[name], JSON.stringify(legacy));
  }
  await rm(paths.marker);
  assert.equal((await loadWorkspaceState(options)).state.documents["note-a"].title, "验收文档");
  for (const [name, path] of Object.entries(paths)) await writeFile(path, originalFiles[name]);

  const beforeDelete = await loadWorkspaceState(options);
  const deleted = structuredClone(beforeDelete.state);
  delete deleted.documents["note-a"];
  delete deleted.documents["board-a"];
  deleted.moduleItems.library = [];
  await saveWorkspaceState({ ...options, state: deleted, expectedStateStamp: beforeDelete.stateStamp });
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { loadWorkspaceState } from ${JSON.stringify(new URL("../src/server/workspace.mjs", import.meta.url).href)};
    const loaded = await loadWorkspaceState(${JSON.stringify(options)});
    assert.equal(loaded.state.documents["note-a"], undefined);
    assert.equal(loaded.state.documents["board-a"], undefined);
    assert.deepEqual(loaded.state.moduleItems.library, []);
  `], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const code = await new Promise((resolveExit) => child.once("exit", resolveExit));
  assert.equal(code, 0, `删除后新进程重启不得复活文档或白板：${stderr.slice(-1200)}`);
  console.log("Workspace commit integrity: current/index/marker mismatch rejected, legacy compatibility and deletion after process restart passed");
} finally {
  assert.ok(resolve(temporaryRoot).toLowerCase().startsWith(`${resolve(tmpdir()).toLowerCase()}\\`));
  await rm(temporaryRoot, { recursive: true, force: true });
}
