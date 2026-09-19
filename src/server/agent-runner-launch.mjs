import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { machineLocalDataRoot } from "./app-data.mjs";
import { readAgentRunnerRegistry } from "./agent-runner-registry.mjs";

const clean = (value = "") => String(value ?? "").replace(/\0/gu, "").trim();

const accessible = async (candidate, accessFile = access) => {
  if (!clean(candidate)) return false;
  try {
    await accessFile(candidate);
    return true;
  } catch {
    return false;
  }
};

const runFile = (executable, args = [], options = {}) => new Promise((resolveRun, rejectRun) => {
  execFile(executable, args, { windowsHide: true, timeout: 4_000, maxBuffer: 256 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) {
      error.stdout = stdout;
      error.stderr = stderr;
      rejectRun(error);
      return;
    }
    resolveRun({ stdout: String(stdout || ""), stderr: String(stderr || "") });
  });
});

const pathDirectories = (environment = process.env) => clean(environment.PATH || environment.Path)
  .split(delimiter)
  .map((item) => item.replace(/^"|"$/gu, "").trim())
  .filter(Boolean);

const knownRunnerLaunchCandidates = ({ runnerId, environment = process.env, homeDirectory = homedir() } = {}) => {
  const directories = pathDirectories(environment);
  const localAppData = clean(environment.LOCALAPPDATA) || join(homeDirectory, "AppData", "Local");
  const roamingAppData = clean(environment.APPDATA) || join(homeDirectory, "AppData", "Roaming");
  const programFiles = clean(environment.ProgramFiles) || "C:\\Program Files";
  const programFilesX86 = clean(environment["ProgramFiles(x86)"]) || "C:\\Program Files (x86)";
  if (runnerId === "workbuddy") return [
    ...directories.flatMap((directory) => [
      { executable: join(directory, "codebuddy.exe"), prefixArgs: [] },
      { executable: process.execPath, prefixArgs: [join(directory, "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy")] },
    ]),
    { executable: join(localAppData, "codebuddy", "bin", "codebuddy.exe"), prefixArgs: [] },
    { executable: join(homeDirectory, "AppData", "Local", "codebuddy", "bin", "codebuddy.exe"), prefixArgs: [] },
    ...[
      join(localAppData, "Programs", "WorkBuddy", "resources", "app.asar.unpacked", "cli", "bin", "codebuddy"),
      join(programFiles, "WorkBuddy", "resources", "app.asar.unpacked", "cli", "bin", "codebuddy"),
      join(programFilesX86, "WorkBuddy", "resources", "app.asar.unpacked", "cli", "bin", "codebuddy"),
    ].map((script) => ({ executable: process.execPath, prefixArgs: [script] })),
    { executable: process.execPath, prefixArgs: [join(roamingAppData, "npm", "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy")] },
  ];
  return [];
};

export const workBuddyInstallRootsFromRegistryOutput = (output = "") => {
  const roots = [];
  const append = (candidate = "") => {
    const executable = clean(candidate).replace(/^"|"$/gu, "").replace(/,\d+$/u, "");
    if (!/\\(?:uninstall\s+)?workbuddy\.exe$/iu.test(executable)) return;
    const root = dirname(executable);
    if (root && !roots.some((item) => item.toLocaleLowerCase() === root.toLocaleLowerCase())) roots.push(root);
  };
  for (const line of String(output || "").split(/\r?\n/u)) {
    const value = line.match(/\bREG_(?:SZ|EXPAND_SZ)\s+(.+)$/iu)?.[1]?.trim() || "";
    if (!value) continue;
    const quoted = value.match(/^"([^"]*\\(?:Uninstall\s+)?WorkBuddy\.exe)"/iu)?.[1];
    append(quoted || value.split(/\s+\/(?:currentuser|S)\b/iu)[0]);
  }
  return roots;
};

const workBuddyDesktopLaunchCandidates = async ({
  environment = process.env,
  homeDirectory = homedir(),
  registryQuery = runFile,
  platform = process.platform,
  nodeExecutable = process.execPath,
} = {}) => {
  const localAppData = clean(environment.LOCALAPPDATA) || join(homeDirectory, "AppData", "Local");
  const programFiles = clean(environment.ProgramFiles) || "C:\\Program Files";
  const programFilesX86 = clean(environment["ProgramFiles(x86)"]) || "C:\\Program Files (x86)";
  const roots = [
    join(localAppData, "Programs", "WorkBuddy"),
    join(programFiles, "WorkBuddy"),
    join(programFilesX86, "WorkBuddy"),
  ];
  if (platform === "win32") {
    const registryRoots = [
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
      "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
      "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    ];
    for (const registryRoot of registryRoots) {
      try {
        const result = await registryQuery("reg.exe", ["query", registryRoot, "/s", "/f", "WorkBuddy"]);
        roots.push(...workBuddyInstallRootsFromRegistryOutput(`${result?.stdout || ""}\n${result?.stderr || ""}`));
      } catch (error) {
        roots.push(...workBuddyInstallRootsFromRegistryOutput(`${error?.stdout || ""}\n${error?.stderr || ""}`));
      }
    }
  }
  return [...new Set(roots.map((root) => resolve(root)))].map((root) => ({
    executable: nodeExecutable,
    prefixArgs: [join(root, "resources", "app.asar.unpacked", "cli", "bin", "codebuddy")],
    installSource: "workbuddy_desktop",
  }));
};

export const resolveRunnerLaunch = async ({
  runnerId,
  environment = process.env,
  homeDirectory = homedir(),
  machineRoot = machineLocalDataRoot(),
  accessFile = access,
  registry = null,
  registryQuery = runFile,
  platform = process.platform,
  nodeExecutable = process.execPath,
} = {}) => {
  const id = clean(runnerId);
  const registered = registry || (machineRoot ? await readAgentRunnerRegistry({ machineRoot }) : {});
  const registeredLaunch = registered?.[id];
  if (id === "workbuddy" && registeredLaunch?.installSource === "workbuddy_desktop"
    && await accessible(registeredLaunch.executable, accessFile)
    && await accessible(registeredLaunch.prefixArgs?.[0], accessFile)) {
    return {
      executable: registeredLaunch.executable,
      prefixArgs: Array.isArray(registeredLaunch.prefixArgs) ? registeredLaunch.prefixArgs : [],
      version: registeredLaunch.version || "",
      installSource: registeredLaunch.installSource,
    };
  }
  // WorkBuddy desktop and its bundled CLI share the same user login state.
  // Prefer that CLI over a stale globally installed npm copy so detection and
  // real execution observe the account that the user actually signed in to.
  if (id === "workbuddy") {
    for (const launch of await workBuddyDesktopLaunchCandidates({
      environment,
      homeDirectory,
      registryQuery,
      platform,
      nodeExecutable,
    })) {
      if (await accessible(launch.executable, accessFile) && await accessible(launch.prefixArgs[0], accessFile)) return launch;
    }
  }
  if (registeredLaunch && await accessible(registeredLaunch.prefixArgs[0] || registeredLaunch.executable, accessFile)) {
    return {
      executable: registeredLaunch.executable,
      prefixArgs: Array.isArray(registeredLaunch.prefixArgs) ? registeredLaunch.prefixArgs : [],
      version: registeredLaunch.version || "",
      installSource: registeredLaunch.installSource || "",
    };
  }
  for (const launch of knownRunnerLaunchCandidates({ runnerId: id, environment, homeDirectory })) {
    const target = launch.prefixArgs[0] || launch.executable;
    if (await accessible(target, accessFile)) return launch;
  }
  const error = new Error(`没有检测到可直接启动的 ${id || "Agent"} CLI`);
  error.code = "ENOENT";
  throw error;
};

export { knownRunnerLaunchCandidates };
