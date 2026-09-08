import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createUpdateManager } from "../src/server/update-manager.mjs";
import { signReleaseManifest, verifyReleaseManifest } from "../src/server/release-manifest.mjs";

const repositoryRoot = new URL("../", import.meta.url);
const config = JSON.parse(await readFile(new URL("../update-config.json", import.meta.url), "utf8"));
const packageMetadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(config.repository, "wu798998264-crypto/shensi");
assert.equal(config.enabled, true);
assert.match(config.manifestPublicKeyPem, /BEGIN PUBLIC KEY/u);
assert.equal(config.allowedPublisher, "CN=Shensi Creative Engine, O=Shensi, C=CN");
assert.ok(packageMetadata.build.files.includes("update-config.json"), "Windows 安装包必须包含更新配置");

const keyRoot = join(String(process.env.LOCALAPPDATA || ""), "ShensiRelease", "signing");
const privateKeyPem = await readFile(join(keyRoot, "manifest-ed25519-private.pem"), "utf8");
const signed = signReleaseManifest({
  privateKeyPem,
  keyId: config.manifestSigningKeyId,
  manifest: {
    schemaVersion: 1,
    product: config.manifestProduct,
    version: "9.9.9",
    buildId: "20260830123456789",
    channel: "stable",
    commit: "a".repeat(64),
    publishedAt: "2026-08-30T00:00:00.000Z",
    runtimeBuildHash: "b".repeat(64),
    dataSchemaVersion: 1,
    minimumSupportedVersion: "1.0.0",
    rollbackCompatibleFrom: "1.0.0",
    supportEndsAt: "",
    assets: [{ name: "Shensi-Setup-9.9.9-20260830123456789-x64.exe", kind: "installer", platform: "win32-x64", sizeBytes: 123, sha256: "c".repeat(64), authenticodePublisher: config.allowedPublisher }],
  },
});
assert.equal(verifyReleaseManifest({ manifest: signed, publicKeyPem: config.manifestPublicKeyPem, expectedKeyId: config.manifestSigningKeyId }).version, "9.9.9");

const root = await mkdtemp(join(tmpdir(), "shensi-update-foundation-"));
try {
  await writeFile(join(root, "update-config.json"), JSON.stringify(config), "utf8");
  const requested = [];
  const manager = createUpdateManager({
    appRoot: root,
    currentVersion: "5.2.6",
    fetchImpl: async (url) => {
      requested.push(String(url));
      if (String(url).endsWith("/releases/latest")) return new Response("{}", { status: 404 });
      if (String(url).endsWith(`/repos/${config.repository}`)) return new Response(JSON.stringify({ full_name: config.repository }), { status: 200 });
      throw new Error(`unexpected URL: ${url}`);
    },
  });
  const status = await manager.check();
  assert.equal(status.configured, true);
  assert.equal(status.securityReady, true);
  assert.equal(status.updateAvailable, false);
  assert.equal(status.installReady, false);
  assert.match(status.message, /尚未发布可用版本/u);
  assert.equal(requested.length, 2, "404 latest release 必须复核仓库本身确实存在");

  const installerBytes = Buffer.from("synthetic signed installer bytes", "utf8");
  const installerName = "Shensi-Setup-5.2.7-20260830123456789-x64.exe";
  const installerSha256 = createHash("sha256").update(installerBytes).digest("hex");
  const releaseManifest = signReleaseManifest({
    privateKeyPem,
    keyId: config.manifestSigningKeyId,
    manifest: {
      schemaVersion: 1,
      product: config.manifestProduct,
      version: "5.2.7",
      buildId: "20260830123456789",
      channel: "stable",
      commit: "d".repeat(64),
      publishedAt: "2026-08-30T00:00:00.000Z",
      runtimeBuildHash: "e".repeat(64),
      dataSchemaVersion: 1,
      minimumSupportedVersion: "1.0.0",
      rollbackCompatibleFrom: "1.0.0",
      supportEndsAt: "",
      assets: [{ name: installerName, kind: "installer", platform: "win32-x64", sizeBytes: installerBytes.length, sha256: installerSha256, authenticodePublisher: config.allowedPublisher }],
    },
  });
  const release = {
    id: 527,
    tag_name: "v5.2.7",
    name: "v5.2.7",
    draft: false,
    prerelease: false,
    assets: [
      { name: installerName, browser_download_url: "https://download.example/installer" },
      { name: "SHA256SUMS.txt", browser_download_url: "https://download.example/checksums" },
      { name: "update-manifest.json", browser_download_url: "https://download.example/manifest" },
    ],
  };
  let publisherVerified = false;
  let installerLaunched = false;
  const installManager = createUpdateManager({
    appRoot: root,
    currentVersion: "5.2.6",
    platform: "win32",
    arch: "x64",
    updateCacheRootImpl: () => join(root, "update-cache"),
    fetchImpl: async (url) => {
      const value = String(url);
      if (value.endsWith("/releases/latest")) return new Response(JSON.stringify(release), { status: 200 });
      if (value === "https://download.example/manifest") return new Response(JSON.stringify(releaseManifest), { status: 200 });
      if (value === "https://download.example/checksums") return new Response(`${installerSha256} *${installerName}\n`, { status: 200 });
      throw new Error(`unexpected install URL: ${url}`);
    },
    downloadFileImpl: async ({ target }) => writeFile(target, installerBytes),
    verifyPublisherImpl: async ({ allowedPublisher }) => { publisherVerified = allowedPublisher === config.allowedPublisher; },
    prepareUserData: async () => ({ transactionId: "update-transaction-1", dataRoot: root }),
    launchInstallerImpl: async ({ dataPreparation }) => {
      installerLaunched = dataPreparation.transactionId === "update-transaction-1";
      return { helperPid: 5270 };
    },
  });
  const update = await installManager.check();
  assert.equal(update.updateAvailable, true);
  assert.equal(update.installReady, true);
  assert.equal(update.latestVersion, "5.2.7");
  const installed = await installManager.install();
  assert.equal(installed.launched, true);
  assert.equal(installed.targetVersion, "5.2.7");
  assert.equal(publisherVerified, true);
  assert.equal(installerLaunched, true);
} finally {
  await rm(root, { recursive: true, force: true });
}

const prepareScript = await readFile(new URL("./windows/prepare-github-release.mjs", import.meta.url), "utf8");
assert.doesNotMatch(prepareScript, /gh\s+release|api\.github\.com|uploadReleaseAsset/u, "发布准备脚本不得自行上传");
assert.match(prepareScript, /timestampSubject/u, "正式更新资产必须带可信时间戳");

console.log("GitHub empty repository and signed update foundation contracts passed");
