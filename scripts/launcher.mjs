#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const configuredInstallRoot = String(process.env.SHENSI_INSTALL_ROOT || "").trim();
const installRoot = configuredInstallRoot && isAbsolute(configuredInstallRoot)
  ? resolve(configuredInstallRoot)
  : resolve(here, "..", "..", "..");
const metadata = JSON.parse(await readFile(join(installRoot, "app", "core", "package.json"), "utf8"));
const version = String(metadata.version || "").trim();
if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("Installed Shensi version metadata is invalid.");
}
const desktopEntry = join(installRoot, "desktop-entry", version, "Shensi Desktop.exe");
const child = spawn(desktopEntry, process.argv.slice(2), {
  cwd: installRoot,
  detached: true,
  env: process.env,
  shell: false,
  windowsHide: true,
  stdio: "ignore",
});
await new Promise((resolveSpawn, rejectSpawn) => {
  child.once("spawn", resolveSpawn);
  child.once("error", rejectSpawn);
});
child.unref();
