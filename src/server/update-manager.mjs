import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { updateCacheRoot } from "./app-data.mjs";
import { verifyReleaseManifest } from "./release-manifest.mjs";

export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

const parseVersion = (value = "") => {
  const source = String(value).trim().replace(/^v(?=\d)/i, "");
  const match = source.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split(".") : [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
    build: match[5] || "",
    normalized: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ""}${match[5] ? `+${match[5]}` : ""}`,
  };
};

const cleanVersion = (value = "") => parseVersion(value)?.normalized || "";

export const compareVersions = (left, right) => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error("软件版本不是有效 SemVer");
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] === b[key]) continue;
    return a[key] > b[key] ? 1 : -1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) > Number(rightPart) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
};

const safePattern = (value, fallback) => {
  const source = String(value || fallback).slice(0, 180);
  return new RegExp(source, "i");
};

const safeAssetName = (value = "update-installer.exe") => basename(String(value)).replace(/[^A-Za-z0-9._-]/g, "-");

const windowsRuntimePlatform = ({ platform, arch }) => platform === "win32" && ["x64", "arm64"].includes(arch) ? `win32-${arch}` : "";

const releaseCandidate = ({ config, release, currentVersion, platform, arch }) => {
  const version = cleanVersion(release?.tag_name || release?.name);
  if (!version) return null;
  const parsedVersion = parseVersion(version);
  if (release?.draft === true || (config.channel === "stable" && (release?.prerelease === true || parsedVersion.prerelease.length))) return null;
  const assetPattern = safePattern(config.assetPattern, "\\.exe$");
  const checksumPattern = safePattern(config.checksumAssetPattern, "^SHA256SUMS(?:\\.txt)?$");
  const manifestPattern = safePattern(config.manifestAssetPattern, "^update-manifest\\.json$");
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const installerAssets = assets.filter((item) => assetPattern.test(String(item.name ?? "")));
  const asset = installerAssets.length === 1 ? installerAssets[0] : null;
  const checksumAsset = assets.find((item) => checksumPattern.test(String(item.name ?? "")));
  const manifestAsset = assets.find((item) => manifestPattern.test(String(item.name ?? "")));
  return {
    config,
    release,
    asset,
    installerAssets,
    checksumAsset,
    manifestAsset,
    latestVersion: version,
    version,
    integrityReady: Boolean(installerAssets.length && checksumAsset && manifestAsset && config.allowedPublisher && config.manifestProduct && config.manifestPublicKeyPem?.includes("PUBLIC KEY") && config.manifestSigningKeyId && windowsRuntimePlatform({ platform, arch })),
    downloadable: Boolean(installerAssets.length && checksumAsset && manifestAsset && config.allowedPublisher && config.manifestProduct && config.manifestPublicKeyPem?.includes("PUBLIC KEY") && config.manifestSigningKeyId && windowsRuntimePlatform({ platform, arch })),
    comparison: compareVersions(version, currentVersion),
  };
};

const publicRelease = (candidate, currentVersion) => ({
  id: String(candidate.release?.id ?? candidate.release?.tag_name ?? candidate.version),
  version: candidate.version,
  name: String(candidate.release?.name || candidate.release?.tag_name || `v${candidate.version}`).slice(0, 160),
  publishedAt: String(candidate.release?.published_at || candidate.release?.created_at || ""),
  notes: String(candidate.release?.body || "").slice(0, 2_000),
  fileName: candidate.asset?.name || "",
  downloadable: candidate.downloadable,
  integrity: {
    sha256Manifest: Boolean(candidate.checksumAsset),
    signedUpdateManifest: Boolean(candidate.manifestAsset && candidate.config.manifestPublicKeyPem && candidate.config.manifestSigningKeyId),
    authenticodeRequired: Boolean(candidate.config.allowedPublisher),
    allowedPublisher: candidate.config.allowedPublisher ? String(candidate.config.allowedPublisher).slice(0, 200) : "",
    verification: "download_before_use",
  },
  current: compareVersions(candidate.version, currentVersion) === 0,
  newer: compareVersions(candidate.version, currentVersion) > 0,
});

const hashFile = (path) => new Promise((resolveHash, rejectHash) => {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("error", rejectHash);
  stream.on("end", () => resolveHash(hash.digest("hex")));
});

const downloadFile = async ({ fetchImpl, url, target }) => {
  const response = await fetchImpl(url, { headers: { "User-Agent": "ShensiCreativeEngine-Updater" } });
  if (!response.ok || !response.body) throw new Error(`更新文件下载失败（${response.status}）`);
  const temporary = `${target}.part`;
  await rm(temporary, { force: true });
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

const verifyWindowsPublisher = async ({ installerPath, allowedPublisher }) => new Promise((resolveSignature, rejectSignature) => {
  const script = [
    "$signature = Get-AuthenticodeSignature -LiteralPath $env:SHENSI_UPDATE_INSTALLER",
    "if ($signature.Status -ne 'Valid') { exit 12 }",
    "if ($signature.SignerCertificate.Subject -ne $env:SHENSI_UPDATE_PUBLISHER) { exit 13 }",
    "if ($null -eq $signature.TimeStamperCertificate) { exit 14 }",
  ].join("; ");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    stdio: "ignore",
    shell: false,
    env: {
      ...process.env,
      SHENSI_UPDATE_INSTALLER: installerPath,
      SHENSI_UPDATE_PUBLISHER: allowedPublisher,
    },
  });
  child.once("error", rejectSignature);
  child.once("exit", (code) => {
    if (code === 0) return resolveSignature(true);
    const error = new Error(code === 13 ? "更新安装包发布者与固定配置不一致" : code === 14 ? "更新安装包缺少可信时间戳" : "更新安装包签名校验失败");
    error.code = code === 13 ? "AUTHENTICODE_PUBLISHER_MISMATCH" : code === 14 ? "AUTHENTICODE_TIMESTAMP_MISSING" : "AUTHENTICODE_SIGNATURE_INVALID";
    rejectSignature(error);
  });
});

const launchInstaller = ({ installerPath, installerArgs = [], appRoot, dataPreparation = {} }) => new Promise((resolveLaunch, rejectLaunch) => {
  if (!dataPreparation.transactionId || !dataPreparation.dataRoot) {
    return rejectLaunch(new Error("更新安装器缺少可恢复的数据事务"));
  }
  const helperPath = join(appRoot, "scripts", "update-installer-helper.mjs");
  const child = spawn(process.execPath, [helperPath], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    shell: false,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      SHENSI_UPDATE_INSTALLER: installerPath,
      SHENSI_UPDATE_INSTALLER_ARGS_JSON: JSON.stringify(installerArgs.map(String)),
      SHENSI_UPDATE_DATA_ROOT: dataPreparation.dataRoot,
      SHENSI_UPDATE_TRANSACTION_ID: dataPreparation.transactionId,
      SHENSI_UPDATE_PARENT_PID: String(process.pid),
    },
  });
  child.once("error", rejectLaunch);
  child.once("spawn", () => {
    child.unref();
    resolveLaunch({ helperPid: child.pid });
  });
});

export const createUpdateManager = ({
  appRoot,
  currentVersion,
  fetchImpl = fetch,
  platform = process.platform,
  arch = process.arch,
  prepareUserData = async () => ({ migrated: 0 }),
  downloadFileImpl = downloadFile,
  verifyPublisherImpl = verifyWindowsPublisher,
  launchInstallerImpl = launchInstaller,
  markInstallerState = async () => {},
  rollbackUserData = async () => ({ restored: false }),
  updateCacheRootImpl = updateCacheRoot,
} = {}) => {
  let status = {
    configured: false,
    securityReady: false,
    disabledReason: "UPDATE_NOT_CONFIGURED",
    checking: false,
    updateAvailable: false,
    currentVersion: cleanVersion(currentVersion),
    latestVersion: "",
    checkedAt: "",
    installReady: false,
    message: "尚未配置更新仓库",
  };
  let candidate = null;
  let releaseCandidates = new Map();

  const readConfig = async () => {
    try {
      const parsed = JSON.parse(await readFile(join(appRoot, "update-config.json"), "utf8"));
      if (!parsed.enabled) return {
        config: null,
        disabledReason: "UPDATE_DISABLED",
        message: "自动更新已安全禁用：尚未配置已签名的正式更新源",
      };
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(parsed.repository ?? ""))) return {
        config: null,
        disabledReason: "UPDATE_REPOSITORY_INVALID",
        message: "自动更新已安全禁用：更新仓库地址无效",
      };
      const config = {
        ...parsed,
        channel: ["stable", "beta", "internal"].includes(parsed.channel) ? parsed.channel : "stable",
        manifestPublicKeyPem: String(parsed.manifestPublicKeyPem || "").replace(/\\n/g, "\n"),
        manifestSigningKeyId: String(parsed.manifestSigningKeyId || "").trim(),
        manifestProduct: String(parsed.manifestProduct || "").trim(),
      };
      const missingTrust = [];
      if (!String(config.allowedPublisher || "").trim()) missingTrust.push("Authenticode 发布者");
      if (!config.manifestProduct) missingTrust.push("产品标识");
      if (!config.manifestPublicKeyPem.includes("PUBLIC KEY")) missingTrust.push("更新清单公钥");
      if (!config.manifestSigningKeyId) missingTrust.push("更新清单 key ID");
      if (missingTrust.length) return {
        config: null,
        disabledReason: "UPDATE_TRUST_INCOMPLETE",
        message: `自动更新已安全禁用：缺少${missingTrust.join("、")}`,
      };
      return { config, disabledReason: "", message: "" };
    } catch (error) {
      if (error.code === "ENOENT") return {
        config: null,
        disabledReason: "UPDATE_NOT_CONFIGURED",
        message: "尚未配置更新仓库",
      };
      throw error;
    }
  };

  const publicStatus = () => ({ ...status });

  const check = async () => {
    status = { ...status, checking: true };
    try {
      const configState = await readConfig();
      const config = configState.config;
      if (!config) {
        candidate = null;
        status = {
          ...status,
          configured: false,
          securityReady: false,
          disabledReason: configState.disabledReason,
          checking: false,
          updateAvailable: false,
          latestVersion: "",
          checkedAt: new Date().toISOString(),
          installReady: false,
          message: configState.message,
        };
        return publicStatus();
      }

      const response = await fetchImpl(`https://api.github.com/repos/${config.repository}/releases/latest`, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "ShensiCreativeEngine-Updater",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (response.status === 404) {
        const repositoryResponse = await fetchImpl(`https://api.github.com/repos/${config.repository}`, {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "ShensiCreativeEngine-Updater",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        });
        if (!repositoryResponse.ok) throw new Error(`更新仓库无法访问（${repositoryResponse.status}）`);
        candidate = null;
        status = {
          configured: true,
          securityReady: true,
          disabledReason: "",
          checking: false,
          updateAvailable: false,
          currentVersion: cleanVersion(currentVersion),
          latestVersion: "",
          checkedAt: new Date().toISOString(),
          installReady: false,
          message: "更新仓库已连接，尚未发布可用版本",
        };
        return publicStatus();
      }
      if (!response.ok) throw new Error(`检查更新失败（${response.status}）`);
      const release = await response.json();
      const latestCandidate = releaseCandidate({ config, release, currentVersion, platform, arch });
      const latestVersion = latestCandidate?.version || "";
      const updateAvailable = Boolean(latestVersion && compareVersions(latestVersion, currentVersion) > 0);
      candidate = updateAvailable ? latestCandidate : null;
      if (latestCandidate) releaseCandidates.set(latestCandidate.version, latestCandidate);
      status = {
        configured: true,
        securityReady: true,
        disabledReason: "",
        checking: false,
        updateAvailable,
        currentVersion: cleanVersion(currentVersion),
        latestVersion,
        checkedAt: new Date().toISOString(),
        installReady: Boolean(updateAvailable && latestCandidate?.downloadable),
        message: updateAvailable ? `发现新版本 ${latestVersion}` : "当前已是最新版本",
      };
      return publicStatus();
    } catch (error) {
      status = { ...status, checking: false, checkedAt: new Date().toISOString(), message: error.message };
      throw error;
    }
  };

  const history = async () => {
    const configState = await readConfig();
    const config = configState.config;
    if (!config) return {
      configured: false,
      securityReady: false,
      disabledReason: configState.disabledReason,
      currentVersion: cleanVersion(currentVersion),
      releases: [],
      message: configState.message,
    };
    const collected = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = await fetchImpl(`https://api.github.com/repos/${config.repository}/releases?per_page=100&page=${page}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "ShensiCreativeEngine-Updater",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (!response.ok) throw new Error(`读取历史版本失败（${response.status}）`);
      const pageReleases = await response.json();
      if (!Array.isArray(pageReleases)) throw new Error("历史版本响应格式无效");
      for (const release of pageReleases) {
        if (release?.draft === true) continue;
        const releaseEntry = releaseCandidate({ config, release, currentVersion, platform, arch });
        if (!releaseEntry?.integrityReady || collected.some((item) => item.version === releaseEntry.version)) continue;
        collected.push(releaseEntry);
      }
      if (pageReleases.length < 100) break;
    }
    releaseCandidates = new Map(collected.map((item) => [item.version, item]));
    return {
      configured: true,
      securityReady: true,
      disabledReason: "",
      currentVersion: cleanVersion(currentVersion),
      releases: collected
        .sort((left, right) => compareVersions(right.version, left.version))
        .map((item) => publicRelease(item, currentVersion)),
      message: collected.length ? `共找到 ${collected.length} 个历史版本` : "尚无可用历史版本",
    };
  };

  const prepareInstaller = async (requestedCandidate) => {
    if (!requestedCandidate) throw new Error("软件历史版本不存在");
    if (platform !== "win32") throw new Error("当前预览版尚未封装 macOS 签名安装器");
    if (!requestedCandidate.installerAssets?.length || !requestedCandidate.checksumAsset || !requestedCandidate.manifestAsset) throw new Error("该版本缺少安装包、SHA256SUMS 或签名更新清单");
    if (!requestedCandidate.config.allowedPublisher) throw new Error("更新配置缺少可信发布者，已拒绝下载");
    if (!requestedCandidate.config.manifestProduct) throw new Error("更新配置缺少固定产品标识，已拒绝下载");
    if (!requestedCandidate.config.manifestPublicKeyPem?.includes("PUBLIC KEY") || !requestedCandidate.config.manifestSigningKeyId) throw new Error("更新配置缺少签名清单固定公钥，已拒绝下载");

    const manifestResponse = await fetchImpl(requestedCandidate.manifestAsset.browser_download_url, {
      headers: { "User-Agent": "ShensiCreativeEngine-Updater" },
    });
    if (!manifestResponse.ok) throw new Error("签名更新清单下载失败");
    const manifestText = (await manifestResponse.text()).slice(0, 2 * 1024 * 1024);
    let releaseManifest;
    try {
      releaseManifest = verifyReleaseManifest({
        manifest: JSON.parse(manifestText),
        publicKeyPem: requestedCandidate.config.manifestPublicKeyPem,
        expectedKeyId: requestedCandidate.config.manifestSigningKeyId,
      });
    } catch (error) {
      throw new Error(`签名更新清单验证失败：${error.message}`);
    }
    if (releaseManifest.version !== requestedCandidate.version) throw new Error("签名更新清单版本与发布标签不一致");
    if (releaseManifest.product !== requestedCandidate.config.manifestProduct) throw new Error("签名更新清单产品标识与固定配置不一致");
    if (releaseManifest.channel !== requestedCandidate.config.channel) throw new Error("签名更新清单通道与固定配置不一致");
    if (releaseManifest.supportEndsAt && Date.parse(releaseManifest.supportEndsAt) < Date.now()) throw new Error("该版本已经超过声明的支持期限");
    if (compareVersions(currentVersion, releaseManifest.minimumSupportedVersion) < 0) throw new Error("当前版本低于该安装包允许的直接升级起点，请先安装受支持的中间版本");
    const requiredPlatform = windowsRuntimePlatform({ platform, arch });
    if (!requiredPlatform) throw new Error("当前 Windows CPU 架构不受更新器支持");
    const compatibleManifestAssets = releaseManifest.assets.filter((item) => item.kind === "installer" && item.platform === requiredPlatform);
    if (compatibleManifestAssets.length !== 1) throw new Error(compatibleManifestAssets.length ? "签名更新清单包含多个当前架构安装包，无法安全选择" : "签名更新清单没有当前 CPU 架构安装包");
    const manifestAsset = compatibleManifestAssets[0];
    const matchingReleaseAssets = requestedCandidate.installerAssets.filter((item) => String(item.name || "") === manifestAsset.name);
    if (matchingReleaseAssets.length !== 1) throw new Error(matchingReleaseAssets.length ? "发布中包含重名安装包，无法安全选择" : "签名更新清单授权的安装包未出现在发布资产中");
    const selectedReleaseAsset = matchingReleaseAssets[0];
    const installerName = safeAssetName(selectedReleaseAsset.name);
    if (installerName !== manifestAsset.name) throw new Error("安装包文件名无法安全映射");
    const cacheRoot = updateCacheRootImpl();
    const versionRoot = resolve(cacheRoot, requestedCandidate.version);
    await mkdir(versionRoot, { recursive: true });
    const installerPath = join(versionRoot, installerName);
    if (manifestAsset.authenticodePublisher !== String(requestedCandidate.config.allowedPublisher)) throw new Error("签名更新清单中的发布者与固定配置不一致");
    const checksumResponse = await fetchImpl(requestedCandidate.checksumAsset.browser_download_url, {
      headers: { "User-Agent": "ShensiCreativeEngine-Updater" },
    });
    if (!checksumResponse.ok) throw new Error("更新校验文件下载失败");
    const checksumText = (await checksumResponse.text()).slice(0, 1024 * 1024);
    const checksumLine = checksumText.split(/\r?\n/).map((line) => line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)).find((match) => match?.[2] === installerName);
    const expectedHash = checksumLine?.[1]?.toLowerCase();
    if (!expectedHash) throw new Error("更新校验文件中没有安装包哈希");
    if (expectedHash !== manifestAsset.sha256) throw new Error("SHA256SUMS 与签名更新清单不一致");
    await rm(installerPath, { force: true });
    await downloadFileImpl({ fetchImpl, url: selectedReleaseAsset.browser_download_url, target: installerPath });
    const actualHash = await hashFile(installerPath);
    const downloadedInfo = await stat(installerPath).catch(() => null);
    if (actualHash !== expectedHash || downloadedInfo?.size !== manifestAsset.sizeBytes) {
      await rm(installerPath, { force: true });
      throw new Error("更新安装包大小或哈希不一致，已删除下载文件");
    }
    await verifyPublisherImpl({ installerPath, allowedPublisher: String(requestedCandidate.config.allowedPublisher) });
    return { installerPath, installerName, version: requestedCandidate.version, releaseManifest };
  };

  const download = async (version) => {
    const requestedVersion = cleanVersion(version);
    if (!requestedVersion) throw new Error("请选择要下载的软件版本");
    if (!releaseCandidates.has(requestedVersion)) await history();
    const prepared = await prepareInstaller(releaseCandidates.get(requestedVersion));
    return { ...publicStatus(), ...prepared, downloaded: true };
  };

  const install = async (version = "", { allowDowngrade = false, repair = false } = {}) => {
    const requestedVersion = cleanVersion(version);
    let requestedCandidate = null;
    if (requestedVersion) {
      if (!releaseCandidates.has(requestedVersion)) await history();
      requestedCandidate = releaseCandidates.get(requestedVersion) ?? null;
    } else {
      if (!candidate || !status.updateAvailable) await check();
      requestedCandidate = candidate;
    }
    if (!requestedCandidate) return { ...publicStatus(), launched: false };
    const comparison = compareVersions(requestedCandidate.version, currentVersion);
    if (comparison < 0 && !allowDowngrade) throw new Error("安装旧版本必须显式确认降级与数据回滚边界");
    if (comparison === 0 && !repair) throw new Error("修复安装当前版本必须显式确认 repair");
    const { installerPath, releaseManifest } = await prepareInstaller(requestedCandidate);
    if (comparison < 0 && compareVersions(currentVersion, releaseManifest.rollbackCompatibleFrom) < 0) throw new Error("当前版本不在该安装包声明的回滚兼容范围内");
    const operation = comparison < 0 ? "downgrade" : comparison === 0 ? "repair" : "upgrade";
    const dataPreparation = await prepareUserData({ targetVersion: requestedCandidate.version, operation, releaseManifest });
    const installerArgs = Array.isArray(requestedCandidate.config.installerArgs) ? requestedCandidate.config.installerArgs.map(String) : ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"];
    try {
      await markInstallerState({ transactionId: dataPreparation.transactionId, phase: "installer_launch_pending" });
      const launch = await launchInstallerImpl({ installerPath, installerArgs, appRoot, dataPreparation });
      return { ...publicStatus(), launched: true, operation, targetVersion: requestedCandidate.version, dataPreparation, helperPid: Number(launch?.helperPid) || 0 };
    } catch (error) {
      const rollback = await rollbackUserData({ transactionId: dataPreparation.transactionId, reason: error?.code || "installer-launch-failed" }).catch(() => null);
      const wrapped = new Error(`更新安装器启动失败，用户数据已恢复：${error.message}`);
      wrapped.code = "UPDATE_INSTALLER_LAUNCH_FAILED";
      wrapped.rollback = rollback;
      throw wrapped;
    }
  };

  return { status: publicStatus, check, history, download, install };
};
