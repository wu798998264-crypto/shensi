import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeDreaminaCliProfileId, validDreaminaCliProfileId } from "../media-cli-presets.js";
import { appDataRoot } from "./app-data.mjs";
import { dreaminaBrokerLeasePath } from "./dreamina-broker-lease.mjs";
import { credentialFileFingerprint, dreaminaExpectedIdentitySync } from "./dreamina-profile-identity-store.mjs";

const moduleRoot = dirname(fileURLToPath(import.meta.url));
const installationRoot = resolve(moduleRoot, "../../../..");
const sourceRoot = resolve(moduleRoot, "../..");

const firstExisting = (candidates = []) => candidates.find((candidate) => candidate && existsSync(candidate)) || candidates.at(-1) || "";

export const dreaminaCliRuntime = (settings = {}) => {
  if (!String(settings.dreaminaCliProfile || "").trim()) {
    throw Object.assign(new Error("当前连接未指定即梦账号，请重新选择配置"), { code: "DREAMINA_PROFILE_REQUIRED", statusCode: 422 });
  }
  if (!validDreaminaCliProfileId(settings.dreaminaCliProfile)) {
    throw Object.assign(new Error("即梦配置 ID 无效，已阻止回退到默认账号"), { code: "DREAMINA_PROFILE_ID_INVALID", statusCode: 422 });
  }
  const profileId = normalizeDreaminaCliProfileId(settings.dreaminaCliProfile);
  const userHome = homedir();
  const executableName = process.platform === "win32" ? "dreamina.exe" : "dreamina";
  const externalExecutable = profileId === "default"
    ? join(userHome, ".local", "bin", executableName)
    : join(userHome, ".local", "bin", "dreamina-profiles", profileId, executableName);
  const sharedExecutable = join(userHome, ".local", "bin", executableName);
  const bundledExecutable = join(installationRoot, "resources", "dreamina-cli", "profiles", profileId, executableName);
  const executable = firstExisting([externalExecutable, sharedExecutable, bundledExecutable]);
  // Every account, including the historical "default" account, owns an
  // isolated credential snapshot. Leaving default in the Windows global
  // keychain allows any later OAuth flow to silently replace it.
  const profileHome = join(userHome, ".dreamina_profiles", profileId);
  const credentialPath = join(profileHome, "auth.reg");
  return {
    profileId,
    executable,
    profileHome,
    credentialPath,
    providerStateRoot: profileId === "default"
      ? join(appDataRoot(), "provider-state")
      : join(appDataRoot(), "provider-state", "dreamina-profiles", profileId),
  };
};

export const dreaminaCliEnvironment = (settings = {}, base = {}) => {
  const runtime = dreaminaCliRuntime(settings);
  const identity = dreaminaExpectedIdentitySync(runtime.profileId);
  const explicitExecutable = String(base.SHENSI_DREAMINA_EXECUTABLE || "").trim();
  const explicitStateRoot = String(base.SHENSI_MEDIA_PROVIDER_STATE_ROOT || "").trim();
  const useWindowsCredentialBroker = process.platform === "win32";
  const brokerPath = firstExisting([
    join(installationRoot, "resources", "scripts", "windows", "dreamina-profile-runner.ps1"),
    join(sourceRoot, "scripts", "windows", "dreamina-profile-runner.ps1"),
  ]);
  const powershellPath = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return {
    ...base,
    SHENSI_DREAMINA_PROFILE_ID: runtime.profileId,
    SHENSI_DREAMINA_EXPECTED_USER_ID: identity.expectedUserId || "",
    SHENSI_DREAMINA_SAVED_CREDIT: Number.isFinite(Number(identity.lastCredit))
      ? String(Number(identity.lastCredit))
      : "",
    SHENSI_DREAMINA_SAVED_CREDIT_AT: identity.creditUpdatedAt || "",
    SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT: credentialFileFingerprint(runtime.credentialPath)
      || String(identity.credentialFingerprint || identity.expectedUserId || "unverified"),
    SHENSI_DREAMINA_BROKER_LEASE_PATH: dreaminaBrokerLeasePath(),
    SHENSI_DREAMINA_EXECUTABLE: useWindowsCredentialBroker ? powershellPath : (explicitExecutable || runtime.executable),
    ...(useWindowsCredentialBroker ? {
      SHENSI_DREAMINA_PREFIX_ARGS: JSON.stringify([
        "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", brokerPath,
        "-ProfileId", runtime.profileId,
        "-Executable", runtime.executable,
      ]),
    } : {}),
    SHENSI_MEDIA_PROVIDER_STATE_ROOT: explicitStateRoot || runtime.providerStateRoot,
    HOME: runtime.profileHome,
    USERPROFILE: runtime.profileHome,
    SHENSI_DREAMINA_PROFILE_HOME: runtime.profileHome,
  };
};
