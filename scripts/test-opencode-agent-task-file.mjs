import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runOpenCodeAgent } from "../src/server/opencode-agent-runner.mjs";

const temporary = await mkdtemp(join(tmpdir(), "shensi-opencode-task-file-test-"));
const mockRunner = join(temporary, "mock-opencode.mjs");
const permissionRunner = join(temporary, "mock-opencode-permissions.mjs");
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

  await writeFile(permissionRunner, `
const args = process.argv.slice(2);
const permission = JSON.parse(process.env.OPENCODE_PERMISSION || "{}");
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}");
process.stdout.write(JSON.stringify({ type: "text", text: JSON.stringify({
  args,
  permission,
  config,
  xdgConfig: process.env.XDG_CONFIG_HOME || "",
  xdgData: process.env.XDG_DATA_HOME || "",
}) }) + "\\n");
`, "utf8");
  const runMode = async (agentPermissionMode) => {
    const modeResult = await runOpenCodeAgent({
      prompt: "Inspect the permission arguments only.",
      cwd: temporary,
      model: "provider/model",
      credentialSource: "opencode",
      agentPermissionMode,
      nativeHost: { url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer test" }, toolNames: ["routes_read"] },
      requestApproval: async () => ({ answer: "deny" }),
      launchResolver: async () => ({ executable: process.execPath, prefixArgs: [permissionRunner] }),
      allocatePermissionPort: async () => 49999,
      fetchImpl: async () => { throw new Error("mock permission server not started"); },
      timeoutMs: 30_000,
    });
    return JSON.parse(modeResult.text);
  };
  const restricted = await runMode("shensi_only");
  assert.equal(restricted.permission.bash, "deny");
  assert.equal(restricted.permission.read, "deny");
  assert.equal(restricted.permission.shensi_routes_read, "allow");
  assert.equal(restricted.config.tools, undefined, "旧 tools 兼容字段会干扰 MCP 权限，必须移除");
  assert.equal(restricted.args.includes("--auto"), true, "非交互模式必须自动答复未被明确拒绝的 MCP 请求");
  assert.notEqual(restricted.xdgConfig, "", "仅限神思必须隔离 OpenCode 宿主配置");
  assert.equal(restricted.xdgData, "", "复用 OpenCode 登录时应保留其凭据数据入口");
  assert.deepEqual(restricted.config.plugin, []);
  const approval = await runMode("approval_required");
  assert.equal(approval.permission.bash, "ask");
  assert.equal(approval.permission.task, "ask");
  assert.equal(approval.args.includes("--pure"), false, "操作需确认必须加载运行器原有扩展环境");
  assert.equal(approval.args[approval.args.indexOf("--port") + 1], "49999");
  const fullAccess = await runMode("full_access");
  assert.equal(fullAccess.permission.bash, "allow");
  assert.equal(fullAccess.permission.task, "allow");
  assert.ok(fullAccess.args.includes("--auto"));
  assert.equal(fullAccess.args.includes("--pure"), false, "完全权限必须保留运行器原有扩展环境");

  await assert.rejects(() => runOpenCodeAgent({
    prompt: "检查权限",
    cwd: temporary,
    model: "provider/model",
    agentPermissionMode: "approval_required",
    launchResolver: async () => ({ executable: process.execPath, prefixArgs: [permissionRunner] }),
  }), /缺少神思审批通道/u);

  const ambientConfig = "C:/ambient/opencode/config";
  const managedFullAccess = await runOpenCodeAgent({
    prompt: "Inspect the managed-provider full-access environment.",
    cwd: temporary,
    model: "provider/model",
    provider: "Managed Provider",
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-managed-secret",
    credentialSource: "shensi",
    agentPermissionMode: "full_access",
    nativeHost: { url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer test" } },
    environment: { ...process.env, XDG_CONFIG_HOME: ambientConfig },
    launchResolver: async () => ({ executable: process.execPath, prefixArgs: [permissionRunner] }),
    timeoutMs: 30_000,
  });
  const managedEnvironment = JSON.parse(managedFullAccess.text);
  assert.equal(managedEnvironment.xdgConfig, ambientConfig, "增强档位下神思凭据不得隔离运行器全局配置");
  assert.equal(Object.hasOwn(managedEnvironment.config, "plugin"), false, "增强档位不得清空全局插件");
  assert.ok(managedEnvironment.args.includes("--auto"));
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log("OpenCode long task file argument tests passed");
