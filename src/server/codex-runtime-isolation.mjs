import { homedir } from "node:os";
import { join, resolve } from "node:path";

const EXACT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/i;
const NPM_INTEGRITY = /^sha512-[A-Za-z0-9+/]{40,}={0,2}$/;

export const SHENSI_CODEX_ISOLATION_ARGS = Object.freeze([
  "-c", "plugins={}",
  "-c", "marketplaces={}",
  "-c", "mcp_servers={}",
  "--disable", "plugins",
  "--disable", "apps",
  "--disable", "hooks",
  "--disable", "skill_search",
  "--disable", "skill_mcp_dependency_install",
  "--disable", "multi_agent",
]);

export const validatePinnedNpmMcp = (entry = {}) => {
  const packageName = String(entry.packageName || "").trim();
  const version = String(entry.version || "").trim();
  const integrity = String(entry.integrity || "").trim();
  if (!NPM_PACKAGE_NAME.test(packageName)) throw new Error("MCP npm 包名无效");
  if (!EXACT_SEMVER.test(version)) throw new Error("MCP npm 包必须锁定精确版本，禁止 @latest 和版本范围");
  if (!NPM_INTEGRITY.test(integrity)) throw new Error("MCP npm 包缺少有效的 sha512 完整性哈希");
  return {
    packageName,
    version,
    integrity,
    packageSpec: `${packageName}@${version}`,
  };
};

export const shensiCodexIsolationPolicy = ({ profileRoot = "" } = {}) => ({
  schemaVersion: 1,
  profileRoot: String(profileRoot || ""),
  authenticationPolicy: "dedicated-profile-auth-only",
  ambientConfiguration: "blocked-by-highest-priority-cli-layer",
  globalPluginsEnabled: false,
  globalMcpEnabled: false,
  globalSkillsEnabled: false,
  allowedMcp: [],
  npmPolicy: "exact-version-and-sha512-integrity-required",
});

export const shensiCodexProfileRoot = (machineRoot) => resolve(
  String(machineRoot || ""),
  "machine-sessions",
  "shensi-codex-profile-v1",
);

export const shensiCodexEnvironment = ({ machineRoot, environment = process.env } = {}) => ({
  ...environment,
  CODEX_HOME: shensiCodexProfileRoot(machineRoot),
});

export const nativeCodexProfileRoot = ({
  environment = process.env,
  homeDirectory = homedir(),
  profileRoot = "",
} = {}) => resolve(
  String(profileRoot || environment.CODEX_HOME || join(homeDirectory, ".codex")),
);

export const nativeCodexEnvironment = ({
  environment = process.env,
  homeDirectory = homedir(),
  profileRoot = "",
} = {}) => ({
  ...environment,
  CODEX_HOME: nativeCodexProfileRoot({ environment, homeDirectory, profileRoot }),
});

export const nativeCodexCapabilityPolicy = ({ profileRoot = "" } = {}) => ({
  schemaVersion: 1,
  runtime: "native-codex-app-server",
  profileRoot: String(profileRoot || ""),
  authenticationPolicy: "reuse-native-codex-account",
  ambientConfiguration: "enabled-read-only-by-shensi",
  globalPluginsEnabled: true,
  globalMcpEnabled: true,
  globalSkillsEnabled: true,
  appsEnabled: true,
  hooksEnabled: true,
  skillSearchEnabled: true,
  multiAgentEnabled: true,
  shensiMayMutateProviderConfiguration: false,
});
