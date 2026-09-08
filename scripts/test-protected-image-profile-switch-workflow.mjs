import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [runner, policy, agents, imageBridge, videoBridge, oauth] = await Promise.all([
  readFile(new URL("./run-protected-image-profile-switch-acceptance.cjs", import.meta.url), "utf8"),
  readFile(new URL("../docs/protected-capabilities/dreamina-image-profile-switch.md", import.meta.url), "utf8"),
  readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
  readFile(new URL("../src/cli/dreamina-image-cli.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/cli/dreamina-video-cli.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/dreamina-profile-oauth.mjs", import.meta.url), "utf8"),
]);

const sequenceBlock = runner.match(/const SEQUENCE = Object\.freeze\(\[([\s\S]*?)\]\);/u)?.[1] || "";
const orderedIds = [...sequenceBlock.matchAll(/profileId:\s*"([^"]+)"/gu)].map((match) => match[1]);
assert.deepEqual(orderedIds, [
  "image-cockpit-aggregate-api",
  "xiaoyujie",
  "guobazai",
  "chenan",
  "tashuo-juyougeng",
  "yinou-shijie",
  "default",
], "受保护顺序必须固定，且只能排除短剧最前线");
assert.doesNotMatch(sequenceBlock, /duanju-zuiqianxian/u, "短剧最前线不得进入付费验收序列");
assert.match(runner, /SHENSI_RUN_PAID_PROFILE_SWITCH_ACCEPTANCE/u, "真实付费验收必须有显式开关");
assert.match(runner, /for \(const step of SEQUENCE\)[\s\S]*?await generateAggregate[\s\S]*?: await generateDreamina/u,
  "跨配置生成必须使用逐步 await 的串行循环");
assert.doesNotMatch(sequenceBlock, /Promise\.all/u, "受保护序列不得并发执行");
assert.match(runner, /await reusableCompletion\(record\)/u, "重跑必须复用已通过哈希验收的步骤");
assert.match(runner, /current\.sha256 === record\.output\.sha256/u, "切换前必须回读并匹配 SHA-256");
assert.match(runner, /identity\.expectedUserId === capability\.userId/u, "即梦实时身份必须与保存身份匹配");
assert.match(runner, /capability\.profileId === step\.profileId/u, "即梦回执配置必须与请求配置匹配");
assert.match(runner, /Object\.hasOwn\(settings, "dreaminaCliProfile"\)/u, "聚合 API 必须检查即梦元数据污染");
assert.match(runner, /process\.env\.ELECTRON_RUN_AS_NODE = "1"/u,
  "Electron DPAPI 验收进程启动即梦桥接时必须显式进入 Node 模式");
assert.match(runner, /for \(let attempt = 1; attempt <= 4; attempt \+= 1\)[\s\S]*?wait-task-resource/u,
  "即梦控制面或任务资源短暂延迟时必须有界等待，不得误报重新核验");
assert.match(runner, /!capability\.generationReady && !record\.providerTaskId/u,
  "已有厂商任务时不得因免费探针短暂延迟阻止原任务续查和下载");
assert.match(runner, /DREAMINA_INSUFFICIENT_CREDIT\|积分为 0\|积分不足/u,
  "真实零积分必须单独分类，不能误报为核验或凭证锁故障");
assert.match(runner, /if \(predecessor && ledger\.steps\[predecessor\.profileId\]\?\.status !== "completed"\)/u,
  "上一张未完整完成时必须拒绝切换");
assert.match(runner, /record\.providerTaskId = job\.providerTaskId[\s\S]*?await atomicJson\(LEDGER_PATH, ledger\)/u,
  "即梦厂商任务号必须先持久化再轮询");
assert.match(runner, /driver\.reconcileSubmission/u, "提交结果不明时必须先用原幂等键找回任务");
assert.doesNotMatch(runner, /userId:\s*(?:capability|identity|live|result)/u, "输出报告不得保存真实 userId");
assert.doesNotMatch(runner, /credentialFingerprint\s*:/u, "输出报告不得保存凭证指纹");
assert.match(imageBridge, /explicit OAuth is the sole owner of login\/relogin operations/u,
  "图片生成探针不得隐式启动 login --headless");
assert.match(videoBridge, /implicit login that monopolizes the global credential slot/u,
  "视频生成探针不得隐式启动 login --headless");
assert.match(oauth, /dreaminaOAuthFinalizationDisposition/u,
  "OAuth 收尾必须通过有界宽限状态机，不能在供应商授权成功后立即回滚");
assert.doesNotMatch(oauth, /invokeProfile\(profileId, \["login", "--headless"\]/u,
  "OAuth 身份回读不得启动第二个 Device Flow 并覆盖刚写入的凭据");
assert.match(policy, /修改前必须请示/u);
assert.match(policy, /不得重复扣费/u);
assert.match(policy, /短剧最前线/u);
assert.match(policy, /兼容独立 CLI/u);
assert.match(agents, /受保护能力：跨配置串行生图/u);
assert.match(agents, /编辑前都必须单独向用户请示/u);
assert.match(agents, /npm run test:protected-image-profile-switch/u);

console.log("Protected aggregate/Dreamina serial image profile-switch workflow contract passed");
