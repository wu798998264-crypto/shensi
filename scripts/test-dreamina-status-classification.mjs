import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sources = await Promise.all([
  readFile(new URL("../src/cli/dreamina-image-cli.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/cli/dreamina-video-cli.mjs", import.meta.url), "utf8"),
]);

for (const source of sources) {
  const activeStatus = source.indexOf("const activeStatuses =");
  const queueHint = source.indexOf(
    'if ((queue.position !== null && queue.position > 0) || /queue|wait|排队/',
  );
  assert.ok(activeStatus >= 0, "即梦 CLI 必须识别明确的生成中状态");
  assert.ok(queueHint >= 0, "即梦 CLI 必须保留队列提示解析");
  assert.ok(activeStatus < queueHint, "明确 Generating/Running 状态必须优先于 queue_position");
  assert.match(source, /const queueStatus = String\(queue\.status/u, "即梦 CLI 必须读取 queue_status");
  assert.match(source, /activeStatuses\.includes\(queueStatus\)/u, "queue_status=Generating 必须显示为生成中");
}

console.log("dreamina status classification: ok");
