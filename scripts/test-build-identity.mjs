import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const root = await readJson("../package.json");
const desktop = await readJson("../packaging/windows/desktop-app/package.json");
const release = await readJson("../release-build.json");
const index = await readFile(new URL("../index.html", import.meta.url), "utf8");

assert.match(root.version, /^\d\.\d\.\d$/u, "release version must use three single-digit segments; carry 7.7.10 to 7.8.0");
assert.equal(root.version, desktop.version, "desktop and application versions must match");
assert.equal(root.version, release.version, "release manifest and application versions must match");
assert.match(index, new RegExp(root.version.replaceAll(".", "\\."), "u"), "visible application version must match the package");
assert.match(root.build?.artifactName || "", /\$\{version\}[\s\S]*SHENSI_BUILD_ID/u, "installer name must include version and unique build id");
assert.match(String(release.buildId || ""), /^\d{17}$/u, "build id must be a millisecond timestamp");

console.log(`Shensi build identity contract passed (${root.version}+${release.buildId})`);
