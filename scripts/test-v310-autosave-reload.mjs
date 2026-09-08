import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");

assert.match(app, /id="autosaveReloadButton"[^>]*>放弃未写入修改/u, "自动保存冲突面板必须准确说明会放弃未落盘修改");
assert.match(app, /autosaveReloadButton[\s\S]{0,320}reloadWorkspaceFromDisk/u, "重新载入按钮必须绑定真实处理器");
assert.match(app, /autosaveReloadButton[\s\S]{0,500}window\.confirm\([\s\S]*?最后一次成功保存的版本/u, "放弃未写入修改前必须明确二次确认");
const reloadBlock = app.slice(app.indexOf("const reloadWorkspaceFromDisk"), app.indexOf("const prefetchWorkspaceState"));
assert.doesNotMatch(reloadBlock, /ensureCurrentRecoveryCheckpoint/u, "放弃未写入修改不能再次依赖已经失败的恢复检查点");
assert.match(app, /\/api\/recovery\/checkpoint\/commit/u, "重新载入必须提交已处理的恢复检查点状态");
assert.match(app, /activateProjectState\(payload\.state/u, "重新载入必须使用规范工作区状态重建内存态");
assert.match(server, /pathname === "\/api\/recovery\/checkpoint\/commit"/u, "服务端必须提供恢复检查点提交接口");
assert.match(server, /commitWorkspaceRecoveryCheckpoint\(\{/u, "服务端必须调用统一恢复检查点提交逻辑");
assert.match(server, /writeStreamEvent\("heartbeat"/u, "流式长任务必须周期性发送心跳");
assert.match(server, /slowResponse: elapsedMs >= 180_000/u, "长任务心跳必须明确标记慢响应而不是静默等待");
assert.match(app, /event\.type === "heartbeat"/u, "客户端必须消费模型心跳并刷新任务状态");

console.log("v3.1.1 autosave conflict reload recovery tests passed");
