import { access, readdir } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { SHENSI_CODEX_ISOLATION_ARGS } from "../server/codex-runtime-isolation.mjs";

const RETRYABLE_LAUNCH_CODES = new Set(["EACCES", "EBUSY", "ENOENT", "EPERM"]);
const DEFAULT_LAUNCH_RETRY_DELAYS_MS = Object.freeze([200, 800]);
const execFileAsync = promisify(execFile);

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const waitForSpawn = (child) => new Promise((resolveSpawn, rejectSpawn) => {
  const cleanup = () => {
    child.removeListener("spawn", handleSpawn);
    child.removeListener("error", handleError);
  };
  const handleSpawn = () => {
    cleanup();
    resolveSpawn();
  };
  const handleError = (error) => {
    cleanup();
    rejectSpawn(error);
  };
  child.once("spawn", handleSpawn);
  child.once("error", handleError);
});

const accessible = async (candidate, accessFile = access) => {
  if (!candidate) return false;
  try {
    const result = await accessFile(candidate);
    return result !== false;
  } catch {
    return false;
  }
};

const npmCodexScriptBesideLauncher = (launcher = "") => join(
  dirname(launcher),
  "node_modules",
  "@openai",
  "codex",
  "bin",
  "codex.js",
);

const windowsWrapperLaunch = async ({ launcher, nodeExecutable, accessFile }) => {
  if (!/\.(?:cmd|ps1)$/i.test(String(launcher || ""))) return null;
  const npmScript = npmCodexScriptBesideLauncher(launcher);
  return await accessible(npmScript, accessFile)
    ? { executable: nodeExecutable, prefixArgs: [npmScript] }
    : null;
};

const launchNotFoundError = () => {
  const error = new Error("没有检测到可直接启动的本机 Codex CLI；已忽略不兼容的裸 codex/codex.cmd/codex.ps1 后备命令");
  error.code = "ENOENT";
  return error;
};

const codexVersionParts = (value = "") => {
  const match = String(value || "").match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/u);
  if (!match) return null;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split(".").map((part) => (/^\d+$/u.test(part) ? Number(part) : part)) : [],
  };
};

const compareCodexVersions = (left, right) => {
  const a = codexVersionParts(left);
  const b = codexVersionParts(right);
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length ? -1 : b.prerelease.length ? 1 : 0;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    if (a.prerelease[index] === b.prerelease[index]) continue;
    if (typeof a.prerelease[index] === "number" && typeof b.prerelease[index] === "number") return a.prerelease[index] - b.prerelease[index];
    if (typeof a.prerelease[index] === "number") return -1;
    if (typeof b.prerelease[index] === "number") return 1;
    return String(a.prerelease[index]).localeCompare(String(b.prerelease[index]));
  }
  return 0;
};

const readCodexCliVersion = async (executable) => {
  const { stdout = "", stderr = "" } = await execFileAsync(executable, ["--version"], {
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  return `${stdout}\n${stderr}`.trim();
};

export const resolveLocalCodexLaunch = async ({
  environment = process.env,
  platform = process.platform,
  homeDirectory = homedir(),
  nodeExecutable = String(environment.SHENSI_NODE_EXECUTABLE || process.execPath),
  accessFile = access,
  readDirectory = readdir,
  resolveVersion = readCodexCliVersion,
} = {}) => {
  const override = String(environment.SHENSI_CODEX_EXECUTABLE || "").trim();
  if (override) {
    let prefixArgs = [];
    try {
      const parsed = JSON.parse(environment.SHENSI_CODEX_PREFIX_ARGS || "[]");
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) prefixArgs = parsed;
    } catch {}
    const portableCommand = /^(?:codex(?:\.(?:exe|cmd|ps1))?)$/i.test(override);
    if (!portableCommand || isAbsolute(override)) {
      const wrapper = platform === "win32" && isAbsolute(override)
        ? await windowsWrapperLaunch({ launcher: override, nodeExecutable, accessFile })
        : null;
      return wrapper || { executable: override, prefixArgs };
    }
  }
  if (platform === "win32") {
    const localAppData = String(environment.LOCALAPPDATA || join(homeDirectory, "AppData", "Local"));
    const roamingAppData = String(environment.APPDATA || join(homeDirectory, "AppData", "Roaming"));
    // Keep the user's explicit npm CLI ahead of desktop/WinGet fallbacks. It
    // owns its own login state and is also the target used by Shensi's
    // one-click installer, so a separately installed alpha desktop binary
    // must not silently replace that authenticated runtime.
    const npmScript = join(roamingAppData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
    if (await accessible(npmScript, accessFile)) return { executable: nodeExecutable, prefixArgs: [npmScript] };
    const bundledRoot = join(localAppData, "OpenAI", "Codex", "bin");
    if (bundledRoot) {
      try {
        const entries = await readDirectory(bundledRoot, { withFileTypes: true });
        const candidates = [];
        for (const entry of entries.filter((item) => item.isDirectory())) {
          const executable = join(bundledRoot, entry.name, "codex.exe");
          if (!await accessible(executable, accessFile)) continue;
          let version = "";
          try { version = await resolveVersion(executable); } catch {}
          candidates.push({ executable, version });
        }
        candidates.sort((left, right) => compareCodexVersions(right.version, left.version));
        if (candidates.length) return { executable: candidates[0].executable, prefixArgs: [], version: candidates[0].version };
      } catch {}
    }

    const pathDirectories = String(environment.PATH || environment.Path || "")
      .split(delimiter)
      .map((entry) => entry.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    for (const directory of pathDirectories) {
      for (const fileName of ["codex.exe", "codex"]) {
        const executable = join(directory, fileName);
        if (await accessible(executable, accessFile)) return { executable, prefixArgs: [] };
      }
      for (const fileName of ["codex.cmd", "codex.ps1"]) {
        const launcher = join(directory, fileName);
        if (!await accessible(launcher, accessFile)) continue;
        const wrapper = await windowsWrapperLaunch({ launcher, nodeExecutable, accessFile });
        if (wrapper) return wrapper;
      }
    }
    const wingetLink = join(localAppData, "Microsoft", "WinGet", "Links", "codex.exe");
    if (await accessible(wingetLink, accessFile)) return { executable: wingetLink, prefixArgs: [] };
    const wingetPackages = join(localAppData, "Microsoft", "WinGet", "Packages");
    try {
      const packageEntries = await readDirectory(wingetPackages, { withFileTypes: true });
      for (const entry of packageEntries.filter((item) => item.isDirectory() && /^OpenAI\.Codex_/iu.test(item.name))) {
        const packageRoot = join(wingetPackages, entry.name);
        const files = await readDirectory(packageRoot, { withFileTypes: true });
        const executableName = files.find((item) => item.isFile() && /^(?:codex|codex-(?:x86_64|aarch64)-pc-windows-msvc)\.exe$/iu.test(item.name))?.name;
        if (executableName) return { executable: join(packageRoot, executableName), prefixArgs: [] };
      }
    } catch {}
    throw launchNotFoundError();
  }

  const pathDirectories = String(environment.PATH || "").split(delimiter).filter(Boolean);
  for (const directory of pathDirectories) {
    const executable = join(directory, "codex");
    if (await accessible(executable, accessFile)) return { executable, prefixArgs: [] };
  }
  throw launchNotFoundError();
};

export const spawnLocalCodexAppServer = async ({
  cwd,
  env = process.env,
  launchResolver = resolveLocalCodexLaunch,
  spawnProcess = spawn,
  retryDelaysMs = DEFAULT_LAUNCH_RETRY_DELAYS_MS,
  isolateConfig = true,
} = {}) => {
  const delays = Array.isArray(retryDelaysMs)
    ? retryDelaysMs.map((value) => Math.max(0, Number(value) || 0)).slice(0, 3)
    : [...DEFAULT_LAUNCH_RETRY_DELAYS_MS];
  let lastError = null;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const launch = await launchResolver();
    if (!String(launch?.executable || "").trim()) {
      const error = new Error("没有检测到本机 Codex CLI");
      error.code = "ENOENT";
      throw error;
    }
    try {
      const child = spawnProcess(
        launch.executable,
        [
          ...(Array.isArray(launch.prefixArgs) ? launch.prefixArgs : []),
          ...(isolateConfig ? SHENSI_CODEX_ISOLATION_ARGS : []),
          "app-server",
          "--listen",
          "stdio://",
        ],
        {
          cwd,
          windowsHide: true,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          env,
        },
      );
      await waitForSpawn(child);
      return { child, launch, retryCount: attempt };
    } catch (error) {
      lastError = error;
      const retryable = RETRYABLE_LAUNCH_CODES.has(String(error?.code || "").toUpperCase());
      if (!retryable || attempt >= delays.length) throw error;
      await delay(delays[attempt]);
    }
  }
  throw lastError || new Error("Codex app-server 无法启动");
};
