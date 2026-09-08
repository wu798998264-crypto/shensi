import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

assert.match(app, /const beginNewGenerationProfile = \(channel\) =>/u, "配置创建必须有统一入口");
assert.ok(app.includes('data-add-generation-connection="${channel}"'), "每个配置下拉菜单末尾必须提供新建配置按钮");
assert.match(app, /const addButton = event\.target\.closest\("\[data-add-generation-connection\]"\)/u, "动态新建按钮必须通过菜单事件委托可用");
assert.match(styles, /\.generation-order-add\s*\{/u, "新建配置按钮必须有独立的下拉菜单样式");

console.log("generation profile picker create-entry contract passed");
