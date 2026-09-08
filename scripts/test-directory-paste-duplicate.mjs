import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

assert.match(app, /data-directory-action="paste"[^>]*>[\s\S]{0,120}<span>粘贴<\/span>/u);
assert.match(app, /data-menu-action="paste"[^>]*>[\s\S]{0,120}<span>粘贴<\/span>/u);
assert.doesNotMatch(app, /粘贴到同级目录|粘贴到此处/u);
assert.match(app, /data-menu-action="duplicate"[^>]*>[\s\S]{0,120}创建副本/u);
assert.match(app, /const duplicateDocumentInPlace = async/u);
assert.match(app, /operation: "copy",[\s\S]{0,350}sourceWorkspacePath: state\.settings\.workspacePath/u);
assert.match(app, /pasteButton\.hidden = false/u, "目录空白处必须始终显示粘贴入口");
assert.match(app, /pasteButton\.disabled = !canPaste/u, "剪贴板为空时应禁用而不是隐藏粘贴入口");

console.log("directory paste and document duplicate UI regressions passed");
