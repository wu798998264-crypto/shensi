import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inspectSelectedSkillSource } from "../src/server/skill-library.mjs";

const [appSource, whiteboardSource, serverSource, securitySource, routingSource] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/whiteboard.js", import.meta.url), "utf8"),
  readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/skill-security.js", import.meta.url), "utf8"),
  readFile(new URL("../src/skill-routing.js", import.meta.url), "utf8"),
]);

const inspection = await inspectSelectedSkillSource({
  selection: { id: "official:book-deconstruction" },
  shensiRoot: process.cwd(),
});

assert.ok(inspection.text.length > 0, "Skill 全文不能为空");
assert.equal(inspection.fullText, true, "官方 Skill 必须完成全文读取");
assert.equal(inspection.sourceContentLength, inspection.text.length, "字符数必须对应全文快照");
assert.equal(inspection.sourceByteLength, Buffer.byteLength(inspection.text, "utf8"), "字节数必须对应 UTF-8 全文快照");
assert.match(inspection.contentHash, /^[0-9a-f]{64}$/u, "全文快照必须提供 SHA-256");
assert.equal(inspection.sourceFileCount, inspection.sourceFiles.length, "源文件数量必须与明细一致");
assert.ok(inspection.sourceFiles.every((file) => file.contentLength > 0 && /^[0-9a-f]{64}$/u.test(file.contentHash)), "每个源文件必须有长度和哈希");

assert.match(serverSource, /displayMode:\s*"full"[\s\S]{0,480}sourceContentLength/u, "Skill 内容接口必须返回全文核验元数据");
assert.match(appSource, /skillAuditRequested[\s\S]{0,1500}sourceProof[\s\S]{0,700}卡片中的 Skill 全文快照/u, "白板明确核验任务必须使用全文快照和计数证明");
assert.match(appSource, /已绑定 \$\{selectionCount\} 个 Skill；任务路由会按本轮任务要求自动选择并完整读取其规则/u, "模块/模组必须保持摘要显示并声明完整路由读取");
assert.match(whiteboardSource, /normalizeSourceInspection[\s\S]{0,1600}sourceContentLength/u, "白板引用状态必须保留全文核验元数据");
assert.match(securitySource, /Skill 文档本身属于公开内容，用户明确询问时可以正常解释/u, "用户 Skill 包装必须允许解释公开文档");
assert.match(routingSource, /公开的 Skill、模块、模组、任务路由和软件运行规则可在用户明确询问时正常解释/u, "任务路由 Skill 必须允许解释公开软件规则");

console.log("白板 Skill 全文显示、核验与模块摘要路由契约测试通过");
