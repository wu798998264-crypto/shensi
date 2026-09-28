import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const source = resolve(fileURLToPath(new URL("..", import.meta.url)));
const moduleRoot = resolve(process.argv[2] || source);
const auditBase = "D:/ShensiAcceptance/2026-09-28-release-audit";
if (process.argv[3] !== "--child") {
  const reuse = process.argv[3] === "--reuse" ? resolve(process.argv[4]) : "";
  if (reuse) assert.ok(reuse.startsWith(resolve(auditBase) + "\\clean-runtime-"), "只能复用本轮新建的验收目录");
  const root = reuse || await mkdtemp(join(auditBase, "clean-runtime-"));
  const blankApp = join(root, "blank-app");
  await mkdir(blankApp, { recursive: true });
  const env = { ...process.env, USERPROFILE: root, HOME: root, APPDATA: join(root, "roaming"), LOCALAPPDATA: join(root, "local"),
    SHENSI_MACHINE_DATA_ROOT: join(root, "machine"), SHENSI_DATA_ROOT: join(root, "data"), SHENSI_LOCAL_H3_ROOT: join(root, "h3"),
    SHENSI_DEPTH_EXPLORER_EXECUTABLE: "", SHENSI_SKIP_UPDATE_CHECK: "1", SHENSI_ACCEPTANCE_ROOT: root, SHENSI_ACCEPTANCE_REUSE: reuse ? "1" : "",
    SHENSI_FFMPEG_PATH: join(source, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe"),
    SHENSI_FFPROBE_PATH: join(source, "node_modules", "@ffprobe-installer", "win32-x64", "ffprobe.exe"),
  };
  console.log(JSON.stringify({ moduleRoot, isolatedRoot: root, note: "Node and FFmpeg are prerequisites; no provider credentials imported" }));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), moduleRoot, "--child"], { env, cwd: blankApp, windowsHide: true, stdio: "inherit" });
  process.exitCode = await new Promise((resolveExit) => { child.once("error", () => resolveExit(1)); child.once("exit", (code) => resolveExit(code ?? 1)); });
} else {
  const root = process.env.SHENSI_ACCEPTANCE_ROOT;
  assert.equal(resolve(homedir()), resolve(root), "不得借用真实用户的深度项目目录");
  const network = await import(pathToFileURL(join(moduleRoot, "src/server/network-proxy.mjs")));
  await network.configureGlobalFetchProxy();
  const depth = await import(pathToFileURL(join(moduleRoot, "src/server/workspace.mjs")));
  const h3 = await import(pathToFileURL(join(moduleRoot, "src/server/local-h3-runtime.mjs")));
  const report = { moduleRoot, root, depth: {}, h3: {} };
  const beforeDepth = await depth.probeWorkspaceDepthExplorer();
  const beforeH3 = await h3.probeLocalH3Runtime();
  if (process.env.SHENSI_ACCEPTANCE_REUSE !== "1") {
    assert.equal(beforeDepth.installable, true, "全新环境不能检测到开发机安装的深度运行器");
    assert.equal(beforeH3.installed, false);
  }
  const watch = async (start, status, name) => {
    let current = await start();
    const id = current.jobId || current.id;
    const deadline = Date.now() + 20 * 60_000;
    let stage = "";
    while (!['complete', 'failed'].includes(current.stage || current.status)) {
      if (Date.now() > deadline) throw new Error(`${name} 装配超过20分钟`);
      if (current.stage !== stage) { stage = current.stage; console.log(JSON.stringify({ component: name, stage, percent: current.percent, message: current.message })); }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
      current = await status(id);
    }
    return current;
  };
  try {
    const h3Install = await watch(h3.startLocalH3Install, h3.localH3InstallStatus, "h3");
    const probe = await h3.probeLocalH3Runtime();
    report.h3 = { installStage: h3Install.stage, installMessage: h3Install.message, installed: probe.installed, ready: probe.ready, reasons: probe.reasons, realGeneration: false };
    console.log(JSON.stringify({ h3: report.h3 }));
    const installed = await watch(depth.startWorkspaceDepthExplorerInstall, depth.workspaceDepthExplorerInstallStatus, "depth");
    report.depth.installStage = installed.stage || installed.status;
    if (report.depth.installStage !== "complete") throw new Error(installed.message);
    const expectedExe = join(root, "machine/runtimes/depth-explorer/0.1.0/深度摸索.exe");
    assert.ok((await stat(expectedExe)).size > 1_000_000);
    const workspacePath = join(root, "data", "作品", "FreshDepth");
    const media = join(workspacePath, "素材");
    await mkdir(media, { recursive: true });
    for (const [kind, args] of [["png", ["-frames:v", "1"]], ["mp4", ["-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]]]) {
      const result = spawnSync(process.env.SHENSI_FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=4:d=2", ...args, "-y", join(media, `reference.${kind}`)], { windowsHide: true, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    const progress = [];
    const generated = await depth.runWorkspaceDepthExplorer({ appRoot: moduleRoot, requestedPath: workspacePath, relativePaths: ["素材/reference.png", "素材/reference.mp4"], settings: { quality: "fast", provider: "cpu", pngBitDepth: 8 }, onProgress: (entry) => {
      progress.push({ completed: entry.completed, total: entry.total, currentPercent: entry.currentPercent, percent: entry.percent });
    } });
    report.depth = { ...report.depth, outputCount: generated.outputs.length, outputs: generated.outputs.map((output) => ({ kind: output.kind, path: output.attachment.relativePath })), progress, realGeneration: generated.outputs.length === 2 };
    console.log(JSON.stringify({ depth: { installStage: report.depth.installStage, realGeneration: report.depth.realGeneration, outputCount: report.depth.outputCount, progressUpdates: progress.length, intermediateProgress: progress.some((p) => p.currentPercent > 0 && p.currentPercent < 100) } }));
  } catch (error) { report.error = error.message; process.exitCode = 1; console.log(JSON.stringify({ error: error.message })); }
  finally {
    const name = process.env.SHENSI_ACCEPTANCE_REUSE === "1" ? "source-recheck-report.json" : "report.json";
    await writeFile(join(root, name), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ reportPath: join(root, name) }));
  }
}
