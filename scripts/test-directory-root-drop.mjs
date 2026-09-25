import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { directoryOrderWithPlacement, directoryRootDropIntent } from "../src/directory-drop.js";

const onlyFolder = ["folder:only"];
const beforeIntent = directoryRootDropIntent({
  parentKey: "manuscript:novel:root",
  siblings: onlyFolder,
  movingTokens: ["document:a"],
  edge: "before",
});
assert.deepEqual(beforeIntent, {
  type: "root",
  parentKey: "manuscript:novel:root",
  targetToken: "folder:only",
  placement: "before",
}, "单根文件夹上方必须形成根级投放意图");
assert.deepEqual(directoryOrderWithPlacement({
  siblings: onlyFolder,
  movingTokens: ["document:a"],
  targetToken: beforeIntent.targetToken,
  placement: beforeIntent.placement,
}), ["document:a", "folder:only"], "文档必须能拖到唯一根文件夹上方");

const afterIntent = directoryRootDropIntent({
  parentKey: "manuscript:novel:root",
  siblings: onlyFolder,
  movingTokens: ["document:a"],
  edge: "after",
});
assert.deepEqual(directoryOrderWithPlacement({
  siblings: onlyFolder,
  movingTokens: ["document:a"],
  targetToken: afterIntent.targetToken,
  placement: afterIntent.placement,
}), ["folder:only", "document:a"], "文档必须能拖到唯一根文件夹下方");

assert.deepEqual(directoryOrderWithPlacement({
  siblings: ["folder:only", "document:b", "folder:last"],
  movingTokens: ["document:a", "document:c"],
  targetToken: "folder:last",
  placement: "before",
}), ["folder:only", "document:b", "document:a", "document:c", "folder:last"], "批量拖出时必须保留所选文档顺序");

assert.deepEqual(directoryOrderWithPlacement({
  siblings: ["document:a", "folder:only", "document:c"],
  movingTokens: ["document:a", "document:c"],
  targetToken: "folder:only",
  placement: "after",
}), ["folder:only", "document:a", "document:c"], "计算根级顺序时必须先移除全部移动项，避免重复");

assert.equal(directoryRootDropIntent({
  parentKey: "manuscript:novel:root",
  siblings: ["document:a"],
  movingTokens: ["document:a"],
  edge: "after",
}), null, "没有剩余根级锚点时不得产生无效投放意图");

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
assert.match(appSource, /data-directory-root-drop="\$\{edge\}"/u, "目录必须渲染根级上下投放区");
assert.match(appSource, /rootZone\.classList\.add\("drop-root-line"\)/u, "根级投放时必须显示插入横线");
assert.match(appSource, /directoryOrder:\s*\{ parentKey: rootIntent\.parentKey, tokens: orderTokens \}/u, "松手后必须持久化根级混合顺序");
assert.match(appSource, /state\.directoryOrders \?\?= \{\};[\s\S]{0,100}state\.directoryOrders\[directoryOrder\.parentKey\]/u, "旧工作区缺少目录顺序表时必须安全初始化");
assert.match(styles, /\.directory-root-drop-zone\.drop-root-line::after\s*\{[\s\S]{0,120}background:\s*var\(--accent\)/u, "根级投放横线必须清晰可见");

console.log("directory root drop tests passed");
