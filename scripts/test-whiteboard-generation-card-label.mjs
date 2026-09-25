import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readBlock = async (file, start, end) => {
  const lines = (await readFile(new URL(file, import.meta.url), "utf8")).split(/\r?\n/u);
  const startIndex = lines.findIndex((line) => line.includes(start));
  assert.notEqual(startIndex, -1, `${file} 缺少定位符：${start}`);
  const endIndex = lines.findIndex((line, index) => index > startIndex && line.includes(end));
  assert.notEqual(endIndex, -1, `${file} 缺少结束定位符：${end}`);
  return lines.slice(startIndex, endIndex + 1).join("\n");
};

const appSource = await readBlock("../src/app.js", "const whiteboardGenerationJobTarget =", "const postGenerationJobAction =");
assert.match(appSource, /nodeName:\s*\(\(\)\s*=>\s*\{/u, "白板媒体任务必须写入用户可见卡片名称");
assert.match(appSource, /normalizeCanvas\(state\.documents\[documentId\]\.canvas\)\.nodes\.find\(\(item\)\s*=>\s*item\.id\s*===\s*nodeId\)/u,
  "卡片名称必须来自当前白板卡片，而不是内部编号");

const recoverySource = await readBlock("../src/app.js", "const mediaRecoveryJobTargetLabel =", "const renderMediaRecoveryJobs =");
assert.match(recoverySource, /liveNode\?\.name\s*\|\|\s*target\.nodeName\s*\|\|\s*"未命名卡片"/u,
  "待处理任务应优先显示当前卡片名称并兼容旧任务持久化名称");
assert.doesNotMatch(recoverySource, /String\(target\.nodeId\)\.slice\(-8\)/u,
  "待处理任务不得把内部 nodeId 后缀作为用户可见卡片名称");

const recoveryBannerSource = await readBlock("../src/app.js", "recoveryIssues.push(`${job.channel", "} else if (!smokeResponse.ok");
assert.match(recoveryBannerSource, /mediaRecoveryJobTargetLabel\(job\)/u,
  "白板恢复错误提示必须显示卡片名称，而不是内部任务编号");
assert.doesNotMatch(recoveryBannerSource, /job\.id\.slice\(-8\)/u,
  "白板恢复错误提示不得暴露内部任务编号");

const storeSource = await readBlock("../src/server/generation-job-store.mjs", "const normalizedTarget =", "const assertGenerationTarget =");
assert.match(storeSource, /nodeName:\s*String\(target\.nodeName\s*\|\|\s*""\)/u,
  "服务端必须持久化白板卡片名称");

const { publicGenerationJob } = await import(`../src/server/generation-job-store.mjs?card-label=${Date.now()}`);
const publicJob = publicGenerationJob({
  id: "generation-card-label-test",
  mode: "server",
  channel: "image",
  status: "failed",
  target: {
    workspaceKind: "project",
    workspacePath: "C:\\workspace",
    documentId: "whiteboard-1",
    nodeId: "node-internal-123",
    nodeName: "当前卡片左上角名称",
    targetType: "whiteboard-node",
  },
  request: { settings: {}, generationProfile: {} },
});
assert.equal(publicJob.target.nodeName, "当前卡片左上角名称", "任务公开数据必须保留卡片可见名称");
assert.notEqual(publicJob.target.nodeName, publicJob.target.nodeId, "卡片名称不能退化为内部编号");

console.log("whiteboard generation card label persistence and recovery display tests passed");
