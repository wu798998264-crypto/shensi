import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const referencedFiles = [];

for (const [name, command] of Object.entries(packageJson.scripts || {})) {
  for (const match of command.matchAll(/(?:^|&&\s*)(?:node|electron)\s+(?!-e\b)([^\s"']+\.(?:mjs|cjs|js))/gu)) {
    referencedFiles.push({ name, file: match[1] });
  }
}

const missing = [];
for (const reference of referencedFiles) {
  try {
    await access(resolve(root, reference.file));
  } catch {
    missing.push(reference);
  }
}

assert.deepEqual(missing, [], `package.json 含失效脚本入口：${missing.map((item) => `${item.name} -> ${item.file}`).join(", ")}`);
console.log(`Package script integrity passed (${referencedFiles.length} executable references)`);
