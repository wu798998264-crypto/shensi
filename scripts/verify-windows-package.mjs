import { access, stat, readFile, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, join, basename } from "node:path";
import { tmpdir } from "node:os";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const releaseBuild = JSON.parse(await readFile(join(root, "release-build.json"), "utf8"));
const expectedName = `Shensi-Setup-${packageJson.version}-${releaseBuild.buildId}-x64.exe`;
const installer = process.argv[2] ? resolve(process.argv[2]) : join(root, "release", "windows", expectedName);
await access(installer);
assertIdentity(basename(installer) === expectedName, `Installer identity mismatch: expected ${expectedName}, received ${basename(installer)}`);

const installerStats = await stat(installer);
assertIdentity(installerStats.size >= 50 * 1024 * 1024, `Installer payload is unexpectedly small (${installerStats.size} bytes)`);
const archiveTool = process.platform === "win32" ? "C:\\Program Files\\7-Zip\\7z.exe" : "7z";
const listed = spawnSync(archiveTool, ["l", installer], { encoding: "utf8" });
assertIdentity(listed.status === 0, `Unable to read NSIS installer: ${listed.stderr || listed.stdout}`);

const verificationRoot = await mkdtemp(join(tmpdir(), "shensi-package-verify-"));
try {
  const outer = spawnSync(archiveTool, ["e", "-y", `-o${verificationRoot}`, installer, "$PLUGINSDIR\\app-64.7z"], { encoding: "utf8" });
  assertIdentity(outer.status === 0, `Unable to extract packaged payload: ${outer.stderr || outer.stdout}`);
  const payloadArchive = join(verificationRoot, "app-64.7z");
  const innerRoot = join(verificationRoot, "payload");
  const inner = spawnSync(archiveTool, ["e", "-y", `-o${innerRoot}`, payloadArchive, "resources\\app\\package.json", "resources\\app\\release-build.json"], { encoding: "utf8" });
  assertIdentity(inner.status === 0, `Unable to inspect packaged build identity: ${inner.stderr || inner.stdout}`);
  const packagedPackage = JSON.parse(await readFile(join(innerRoot, "package.json"), "utf8"));
  const packagedBuild = JSON.parse(await readFile(join(innerRoot, "release-build.json"), "utf8"));
  assertIdentity(packagedPackage.version === packageJson.version, `Packaged version is ${packagedPackage.version}; expected ${packageJson.version}`);
  assertIdentity(packagedBuild.version === packageJson.version, `Packaged release version is ${packagedBuild.version}; expected ${packageJson.version}`);
  assertIdentity(packagedBuild.buildId === releaseBuild.buildId, `Packaged buildId is ${packagedBuild.buildId}; expected ${releaseBuild.buildId}`);
  assertIdentity(packagedBuild.publishable === true, "Packaged build is not marked publishable");
} finally {
  await rm(verificationRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, installer, bytes: installerStats.size, version: packageJson.version, buildId: releaseBuild.buildId }));

function assertIdentity(condition, message) {
  if (!condition) throw new Error(message);
}
