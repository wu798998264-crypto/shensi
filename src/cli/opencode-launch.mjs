import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

const accessible = async (candidate, accessFile = access) => {
  if (!candidate) return false;
  try {
    await accessFile(candidate);
    return true;
  } catch {
    return false;
  }
};

const prefixArgsFromEnvironment = (environment = {}) => {
  try {
    const parsed = JSON.parse(environment.SHENSI_OPENCODE_PREFIX_ARGS || "[]");
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
};

const npmOpenCodeExecutableBesideLauncher = (launcher = "") => join(
  dirname(launcher),
  "node_modules",
  "opencode-ai",
  "bin",
  "opencode.exe",
);

const windowsWrapperLaunch = async ({ launcher, accessFile }) => {
  if (!/\.(?:cmd|ps1)$/i.test(String(launcher || ""))) return null;
  const executable = npmOpenCodeExecutableBesideLauncher(launcher);
  return await accessible(executable, accessFile) ? { executable, prefixArgs: [] } : null;
};

const launchNotFoundError = () => {
  const error = new Error("没有检测到可直接启动的本机 OpenCode CLI；请先安装 opencode-ai");
  error.code = "ENOENT";
  return error;
};

export const resolveLocalOpenCodeLaunch = async ({
  environment = process.env,
  platform = process.platform,
  homeDirectory = homedir(),
  accessFile = access,
} = {}) => {
  const override = String(environment.SHENSI_OPENCODE_EXECUTABLE || "").trim();
  if (override) {
    const prefixArgs = prefixArgsFromEnvironment(environment);
    if (platform === "win32" && isAbsolute(override)) {
      const wrapper = await windowsWrapperLaunch({ launcher: override, accessFile });
      if (wrapper) return wrapper;
    }
    const portableCommand = /^(?:opencode(?:\.(?:exe|cmd|ps1))?)$/i.test(override);
    if (!portableCommand || isAbsolute(override)) return { executable: override, prefixArgs };
  }

  const pathDirectories = String(environment.PATH || environment.Path || "")
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);

  if (platform === "win32") {
    const roamingAppData = String(environment.APPDATA || join(homeDirectory, "AppData", "Roaming"));
    const globalNpmExecutable = join(roamingAppData, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
    if (await accessible(globalNpmExecutable, accessFile)) return { executable: globalNpmExecutable, prefixArgs: [] };

    for (const directory of pathDirectories) {
      for (const fileName of ["opencode.exe", "opencode"]) {
        const executable = join(directory, fileName);
        if (await accessible(executable, accessFile)) return { executable, prefixArgs: [] };
      }
      for (const fileName of ["opencode.cmd", "opencode.ps1"]) {
        const launcher = join(directory, fileName);
        if (!await accessible(launcher, accessFile)) continue;
        const wrapper = await windowsWrapperLaunch({ launcher, accessFile });
        if (wrapper) return wrapper;
      }
    }
    throw launchNotFoundError();
  }

  for (const directory of pathDirectories) {
    const executable = join(directory, "opencode");
    if (await accessible(executable, accessFile)) return { executable, prefixArgs: [] };
  }
  throw launchNotFoundError();
};
