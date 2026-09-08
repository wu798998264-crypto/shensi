import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runOpenCodeAgent } from "../src/server/opencode-agent-runner.mjs";

const temporary = await mkdtemp(join(tmpdir(), "shensi-opencode-task-file-test-"));
const mockRunner = join(temporary, "mock-opencode.mjs");
const marker = "SHENSI_OPENCODE_LONG_TASK_OK";

try {
  await writeFile(mockRunner, `
import { readFile } from "node:fs/promises";
const args = process.argv.slice(2);
const fileIndex = args.indexOf("--file");
const instructionIndex = args.indexOf("Execute the complete task in the attached task.md file.");
if (fileIndex < 0 || instructionIndex < 0 || instructionIndex > fileIndex) {
  process.stderr.write("prompt and --file order is invalid");
  process.exit(2);
}
if (!args[fileIndex + 1] || args[fileIndex + 2]) {
  process.stderr.write("--file must receive exactly one path");
  process.exit(3);
}
const task = await readFile(args[fileIndex + 1], "utf8");
if (!task.includes(${JSON.stringify(marker)})) {
  process.stderr.write("task file content is missing");
  process.exit(4);
}
process.stdout.write(JSON.stringify({ type: "text", text: ${JSON.stringify(marker)} }) + "\\n");
`, "utf8");

  const result = await runOpenCodeAgent({
    prompt: `${marker}\n${"长任务内容".repeat(9_000)}`,
    cwd: temporary,
    model: "deepseek/deepseek-test",
    credentialSource: "opencode",
    launchResolver: async () => ({ executable: process.execPath, prefixArgs: [mockRunner] }),
    timeoutMs: 30_000,
  });

  assert.equal(result.text, marker);
  assert.equal(result.model, "deepseek/deepseek-test");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log("OpenCode long task file argument tests passed");
