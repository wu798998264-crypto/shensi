import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyLibTvCliError, LibTvMediaDriver } from "../src/server/media-provider-drivers.mjs";

const transport = classifyLibTvCliError(
  Object.assign(new Error("fetch failed"), {
    providerErrorCode: "DRIVER_EXIT_FAILED",
    stderr: "ConnectTimeoutError: api2.liblib.art:443",
  }),
  { phase: "创建生成节点" },
);
assert.equal(transport.providerErrorCode, "LIBTV_NETWORK_UNREACHABLE");
assert.equal(transport.libTvNetworkFailure, true);
assert.equal(transport.libTvEndpoint, "api2.liblib.art:443");
assert.match(transport.message, /创建生成节点网络请求失败/u);
assert.match(transport.message, /api2\.liblib\.art:443/u);

const root = await mkdtemp(join(tmpdir(), "shensi-libtv-network-recovery-"));
try {
  const referencePath = join(root, "reference.png");
  await writeFile(referencePath, Buffer.from("test"));
  const driver = new LibTvMediaDriver();
  const calls = [];
  driver.project = async () => ({ projectUuid: "project-1" });
  driver.invoke = async (args, options = {}) => {
    calls.push({ args, options });
    if (args[0] === "node" && args[1] === "list") {
      return { nodes: [
        { id: "reference-1", type: "image", name: "神思参考-1-generation-libtv-recovery" },
        { id: "target-1", type: "image", name: "神思-image-generation-libtv-recovery" },
      ] };
    }
    if (args.at(-1) === "--run") return { status: "running", taskId: "target-1" };
    throw new Error(`不应重复调用：${args.join(" ")}`);
  };
  const result = await driver.submit({
    job: {
      id: "generation-libtv-recovery",
      attempt: 2,
      safeNoTaskRetry: true,
      channel: "image",
      request: {
        prompt: "恢复节点",
        aspectRatio: "1:1",
        quality: "standard",
        imageCount: 1,
        settings: { model: "lib-image-2.5-s" },
      },
    },
    references: [{ absolutePath: referencePath, mimeType: "image/png" }],
    workRoot: root,
  });
  assert.equal(result.providerTaskId, "target-1");
  assert.equal(calls.filter(({ args }) => args[0] === "upload").length, 0, "重试不能重复上传参考物");
  assert.equal(calls.filter(({ args }) => args[0] === "node" && args[1] === "create").length, 0, "重试不能重复创建目标节点");
  assert.equal(calls.filter(({ args }) => args[0] === "node" && args[1] === "list").length, 1, "重试只需读取一次节点列表");
  const persisted = JSON.parse(await readFile(join(root, "libtv-node.json"), "utf8"));
  assert.equal(persisted.nodeKey, "target-1");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("LibTV network diagnostics and idempotent recovery passed");
