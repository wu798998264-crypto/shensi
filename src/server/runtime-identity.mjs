import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";

export const RUNTIME_PROTOCOL_VERSION = 2;
const CODE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".css", ".html", ".json"]);

const sourceFiles = async (root) => {
  const files = [
    join(root, "server.mjs"),
    join(root, "index.html"),
    join(root, "package.json"),
    join(root, "scripts", "launcher.mjs"),
    join(root, "packaging", "bundled", "shensi-bundle-manifest.json"),
  ];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(path);
    }
  };
  await visit(join(root, "src"));
  await visit(join(root, "packaging", "windows", "desktop-app")).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  return files.sort((left, right) => left.localeCompare(right));
};

export const runtimeIdentity = async (root) => {
  const packageMetadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const hash = createHash("sha256");
  for (const path of await sourceFiles(root)) {
    hash.update(relative(root, path).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  const sourceHash = hash.digest("hex");
  return {
    version: packageMetadata.version,
    dataSchemaVersion: Number(packageMetadata.dataSchemaVersion || 1),
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    buildHash: sourceHash.slice(0, 24),
    sourceHash,
  };
};
