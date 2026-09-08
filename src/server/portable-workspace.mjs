import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const MANIFEST_NAME = ".shensi-portable.json";
const SKIPPED = new Set([".git", "node_modules", ".shensi"]);

const checksum = (path) => new Promise((resolveHash, rejectHash) => {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("error", rejectHash);
  stream.on("end", () => resolveHash(hash.digest("hex")));
});

const portableFiles = async (workspaceRoot) => {
  const files = [];
  const queue = [workspaceRoot];
  while (queue.length) {
    const current = queue.shift();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === MANIFEST_NAME || SKIPPED.has(entry.name)) continue;
      const target = join(current, entry.name);
      if (entry.isDirectory()) queue.push(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  return files.sort();
};

export const createPortableWorkspaceManifest = async (workspacePath, { write = true } = {}) => {
  const workspaceRoot = resolve(workspacePath);
  const files = await portableFiles(workspaceRoot);
  const entries = [];
  for (const path of files) {
    const info = await stat(path);
    entries.push({
      path: relative(workspaceRoot, path).replaceAll("\\", "/"),
      bytes: info.size,
      sha256: await checksum(path),
      kind: /\.md$/i.test(path) ? "markdown" : /\.canvas$/i.test(path) ? "canvas" : "asset",
    });
  }
  const manifest = {
    schemaVersion: 1,
    format: "shensi-portable-workspace",
    createdAt: new Date().toISOString(),
    sourceOfTruth: "plain-files",
    files: entries,
  };
  if (write) await writeFile(join(workspaceRoot, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
};

export const verifyPortableWorkspaceManifest = async (workspacePath) => {
  const workspaceRoot = resolve(workspacePath);
  const manifest = JSON.parse(await readFile(join(workspaceRoot, MANIFEST_NAME), "utf8"));
  const mismatches = [];
  for (const entry of manifest.files ?? []) {
    const target = resolve(workspaceRoot, entry.path);
    if (relative(workspaceRoot, target).startsWith("..")) {
      mismatches.push({ path: entry.path, reason: "path_escape" });
      continue;
    }
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) mismatches.push({ path: entry.path, reason: "missing" });
    else if (info.size !== entry.bytes || await checksum(target) !== entry.sha256) mismatches.push({ path: entry.path, reason: "checksum" });
  }
  return { valid: mismatches.length === 0, checked: manifest.files?.length ?? 0, mismatches, manifest };
};
