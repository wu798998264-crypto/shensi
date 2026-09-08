import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

const clean = (value = "") => String(value || "").trim();

const accessible = async (candidate, accessFile = access) => {
  try { await accessFile(candidate); return true; } catch { return false; }
};

export const resolveLocalClaudeCodeLaunch = async ({
  environment = process.env,
  platform = process.platform,
  homeDirectory = homedir(),
  accessFile = access,
} = {}) => {
  const override = clean(environment.SHENSI_CLAUDE_CODE_EXECUTABLE);
  if (override) {
    const portableCommand = /^(?:claude(?:\.(?:exe|cmd|ps1))?)$/iu.test(override);
    if ((!portableCommand || isAbsolute(override)) && (!isAbsolute(override) || await accessible(override, accessFile))) {
      return { executable: override, prefixArgs: [] };
    }
  }
  const directories = clean(environment.PATH || environment.Path).split(delimiter).map((item) => item.replace(/^"|"$/gu, "").trim()).filter(Boolean);
  const names = platform === "win32" ? ["claude.exe", "claude"] : ["claude"];
  if (platform === "win32") {
    const roamingAppData = clean(environment.APPDATA) || join(homeDirectory, "AppData", "Roaming");
    const localAppData = clean(environment.LOCALAPPDATA) || join(homeDirectory, "AppData", "Local");
    const npmNative = join(roamingAppData, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (await accessible(npmNative, accessFile)) return { executable: npmNative, prefixArgs: [] };
    for (const candidate of [
      join(localAppData, "Microsoft", "WinGet", "Links", "claude.exe"),
      join(localAppData, "Programs", "ClaudeCode", "claude.exe"),
    ]) if (await accessible(candidate, accessFile)) return { executable: candidate, prefixArgs: [] };
  }
  for (const directory of directories) for (const name of names) {
    const candidate = join(directory, name);
    if (await accessible(candidate, accessFile)) return { executable: candidate, prefixArgs: [] };
  }
  if (platform === "win32") {
    const candidate = join(homeDirectory, ".local", "bin", "claude.exe");
    if (await accessible(candidate, accessFile)) return { executable: candidate, prefixArgs: [] };
  }
  const error = new Error("没有检测到可直接启动的 Claude Code CLI；请先安装 Claude Code");
  error.code = "ENOENT";
  throw error;
};

export const claudeCodeCommandArgs = ({
  prompt = "",
  model = "",
  maxTurns = 8,
  permissionMode = "default",
} = {}) => {
  const task = clean(prompt);
  if (!task) throw new Error("Claude Code 没有收到任务指令");
  const args = ["-p", task, "--output-format", "json"];
  if (clean(model)) args.push("--model", clean(model));
  args.push("--max-turns", String(Math.max(1, Math.min(100, Number(maxTurns) || 8))));
  args.push("--permission-mode", clean(permissionMode) || "default");
  return args;
};

export const parseClaudeCodeJsonResult = (stdout = "") => {
  let payload;
  try { payload = JSON.parse(String(stdout || "").trim()); } catch {
    throw new Error("Claude Code 没有返回有效 JSON");
  }
  const text = clean(payload?.result || payload?.text || payload?.content);
  if (!text) throw new Error("Claude Code 已结束，但没有返回可用文本");
  return { text, sessionId: clean(payload?.session_id || payload?.sessionId) };
};

export const launchClaudeCode = (command = "claude", args = [], { cwd = "", environment = process.env, signal = null } = {}) => new Promise((resolve, reject) => {
  const child = spawn(clean(command) || "claude", args, {
    cwd: clean(cwd) || process.cwd(),
    env: environment,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    signal: signal || undefined,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-8 * 1024 * 1024); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_000); });
  child.once("error", reject);
  child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
});
