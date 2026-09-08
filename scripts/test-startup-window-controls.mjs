import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../packaging/windows/desktop-app/main.mjs", import.meta.url), "utf8");

assert.match(source, /RECOVERY_MINIMIZE_URL/u);
assert.match(source, /RECOVERY_MAXIMIZE_URL/u);
assert.match(source, /RECOVERY_CLOSE_URL/u);
assert.match(source, /class="startup-window-controls"/u);
assert.match(source, /aria-label="最小化"/u);
assert.match(source, /aria-label="最大化或还原"/u);
assert.match(source, /aria-label="关闭"/u);
assert.match(source, /url === RECOVERY_MINIMIZE_URL[\s\S]{0,180}mainWindow\.minimize\(\)/u);
assert.match(source, /url === RECOVERY_MAXIMIZE_URL[\s\S]{0,260}mainWindow\.isMaximized\(\)/u);
assert.match(source, /url === RECOVERY_CLOSE_URL[\s\S]{0,180}mainWindow\.hide\(\)/u);

console.log("startup loading window controls regressions passed");
