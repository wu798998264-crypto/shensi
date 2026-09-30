import assert from "node:assert/strict";
import { resolveWorkBuddyModelId } from "../src/server/workbuddy-desktop-bridge.mjs";

const models = [
  { id: "fast-model", name: "快速" },
  { id: "hy3-c", name: "Hy3" },
  { id: "hy3-x", name: "Hy3" },
  { id: "deepseek-v4-pro", name: "Deepseek-V4-Pro" },
];

assert.equal(resolveWorkBuddyModelId("hy3", models), "hy3-c", "旧 hy3 应映射当前目录首个 Hy3 模型");
assert.equal(resolveWorkBuddyModelId("hy3-c", models), "hy3-c", "当前真实 ID 应保持不变");
assert.equal(resolveWorkBuddyModelId("Deepseek-V4-Pro", models), "deepseek-v4-pro", "模型标签应支持大小写/分隔符归一化");
assert.equal(resolveWorkBuddyModelId("not-present", models), "", "无匹配模型不能伪装成可用模型");

console.log("WorkBuddy model alias contract passed");
