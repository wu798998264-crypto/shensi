import { createHash } from "node:crypto";
import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { signReleaseManifest, verifyReleaseManifest } from "../../src/server/release-manifest.mjs";
import { runtimeIdentity } from "../../src/server/runtime-identity.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptRoot, "..", "..");
const packageMetadata = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const releaseBuild = JSON.parse(await readFile(join(repositoryRoot, "release-build.json"), "utf8"));
const updateConfig = JSON.parse(await readFile(join(repositoryRoot, "update-config.json"), "utf8"));
const version = String(packageMetadata.version || "");
const buildId = String(releaseBuild.buildId || "");

if (releaseBuild.publishable !== true) throw new Error("当前构建未标记为可发布");
if (releaseBuild.version !== version) throw new Error("release-build.json 与 package.json 版本不一致");
if (!/^[1-9]\d{16}$/.test(buildId)) throw new Error("正式发布 buildId 必须是 17 位时间戳");
if (updateConfig.enabled !== true || !updateConfig.repository) throw new Error("GitHub 更新仓库尚未启用");

const expectedInstallerName = `Shensi-Setup-${version}-${buildId}-x64.exe`;
const requestedInstaller = process.argv[2]
  ? resolve(process.argv[2])
  : join(repositoryRoot, "release", "windows", expectedInstallerName);
if (basename(requestedInstaller) !== expectedInstallerName) throw new Error(`安装包名称必须是 ${expectedInstallerName}`);
const installerInfo = await stat(requestedInstaller).catch(() => null);
if (!installerInfo?.isFile() || installerInfo.size <= 10 * 1024 * 1024) throw new Error("正式 Windows 安装包不存在或体积异常");

const signatureScript = [
  "$signature = Get-AuthenticodeSignature -LiteralPath $env:SHENSI_RELEASE_INSTALLER",
  "$result = [ordered]@{",
  "  status = [string]$signature.Status",
  "  subject = [string]$signature.SignerCertificate.Subject",
  "  timestampSubject = [string]$signature.TimeStamperCertificate.Subject",
  "}",
  "$result | ConvertTo-Json -Compress",
].join("\n");
const signatureProcess = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", signatureScript], {
  encoding: "utf8",
  windowsHide: true,
  env: { ...process.env, SHENSI_RELEASE_INSTALLER: requestedInstaller },
});
if (signatureProcess.status !== 0) throw new Error("无法验证 Windows 安装包签名");
const signature = JSON.parse(String(signatureProcess.stdout || "{}").trim() || "{}");
if (signature.status !== "Valid") throw new Error(`Windows 安装包签名无效：${signature.status || "未知状态"}`);
if (signature.subject !== updateConfig.allowedPublisher) throw new Error("Windows 安装包发布者与更新固定配置不一致");
if (!signature.timestampSubject) throw new Error("Windows 安装包缺少可信时间戳，不允许准备公开更新");

const hash = createHash("sha256");
hash.update(await readFile(requestedInstaller));
const installerSha256 = hash.digest("hex");
const runtime = await runtimeIdentity(repositoryRoot);
const declaredCommit = String(releaseBuild.commit || "").toLowerCase();
const sourceRevision = /^[a-f0-9]{40,64}$/.test(declaredCommit) ? declaredCommit : runtime.sourceHash;
const localAppData = String(process.env.LOCALAPPDATA || "").trim();
const defaultPrivateKey = localAppData ? join(localAppData, "ShensiRelease", "signing", "manifest-ed25519-private.pem") : "";
const privateKeyPath = resolve(String(process.env.SHENSI_UPDATE_MANIFEST_PRIVATE_KEY || defaultPrivateKey));
const privateKeyPem = await readFile(privateKeyPath, "utf8").catch(() => "");
if (!privateKeyPem.includes("PRIVATE KEY")) throw new Error("本机更新清单私钥不存在；请先运行 initialize-update-signing-key.mjs");

const manifest = signReleaseManifest({
  keyId: updateConfig.manifestSigningKeyId,
  privateKeyPem,
  manifest: {
    schemaVersion: 1,
    product: updateConfig.manifestProduct,
    version,
    buildId,
    channel: updateConfig.channel,
    commit: sourceRevision,
    publishedAt: new Date().toISOString(),
    runtimeBuildHash: runtime.sourceHash,
    dataSchemaVersion: Number(packageMetadata.dataSchemaVersion || 1),
    minimumSupportedVersion: String(updateConfig.minimumSupportedVersion || "1.0.0"),
    rollbackCompatibleFrom: String(updateConfig.rollbackCompatibleFrom || "1.0.0"),
    supportEndsAt: "",
    assets: [{
      name: expectedInstallerName,
      kind: "installer",
      platform: "win32-x64",
      sizeBytes: installerInfo.size,
      sha256: installerSha256,
      authenticodePublisher: updateConfig.allowedPublisher,
    }],
  },
});
verifyReleaseManifest({
  manifest,
  publicKeyPem: updateConfig.manifestPublicKeyPem,
  expectedKeyId: updateConfig.manifestSigningKeyId,
});

const outputRoot = join(repositoryRoot, "release", "github", `v${version}-${buildId}`);
await mkdir(outputRoot, { recursive: true });
const checksumPath = join(outputRoot, "SHA256SUMS.txt");
const manifestPath = join(outputRoot, "update-manifest.json");
const planPath = join(outputRoot, "release-assets.json");
await writeFile(checksumPath, `${installerSha256} *${expectedInstallerName}\n`, "utf8");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await writeFile(planPath, `${JSON.stringify({
  schemaVersion: 1,
  uploadPerformed: false,
  repository: updateConfig.repository,
  tag: `v${version}`,
  version,
  buildId,
  assets: [requestedInstaller, checksumPath, manifestPath],
}, null, 2)}\n`, "utf8");

process.stdout.write(JSON.stringify({
  ok: true,
  uploadPerformed: false,
  repository: updateConfig.repository,
  version,
  buildId,
  installer: requestedInstaller,
  checksumPath,
  manifestPath,
  planPath,
}, null, 2));
