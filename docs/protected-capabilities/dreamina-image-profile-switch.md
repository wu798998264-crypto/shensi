# 跨配置串行生图（受保护能力）

## 能力定义

神思必须支持下列真实工作流，并保证供应商、账号与产物不串号：

1. 使用“聚合api”生成一张图片并完成下载验收。
2. 严格串行切换“小鱼姐 → 锅巴仔 → 陈安 → 她说剧有梗 → 银鸥师姐”，每个即梦配置各生成一张图片。
3. 明确排除“短剧最前线”（`duanju-zuiqianxian`）。
4. 最后切回“柏物语”（`default`）再生成一张图片。
5. 每一步必须在厂商任务完成、文件下载、尺寸校验和 SHA-256 回读通过后，才允许进入下一步。

该能力验证的是聚合 API 与即梦之间的切换、即梦全局凭证锁的释放、各即梦配置的身份隔离、厂商任务幂等恢复以及最终产物完整性。配置面板显示“已核验”不等于实时可生成，真实验收必须使用实时身份和任务资源探针。

## 修改前必须请示

下列范围的修改可能使本能力回退。在编辑业务代码前，必须单独向用户报备：说明准备修改的文件与行为、对凭证锁/账号隔离/跨供应商切换的风险、计划运行的专项回归，并取得明确同意。一般性的“修复其他功能”或“继续开发”不视为本能力修改授权。

- `src/server/dreamina-*`
- `src/cli/dreamina-image-cli.mjs`
- `src/server/media-provider-drivers.mjs` 中的即梦图片驱动
- `src/server/adapters.mjs` 中的图片生成适配与路由
- `src/server/media-generation-worker.mjs`、任务恢复与幂等逻辑
- `src/generation-profiles.js` 中的聚合 API 或即梦图片配置
- 即梦全局凭证锁、配置选择和白板图片配置切换逻辑
- 本文档列出的受保护验收脚本、顺序和门禁

## 必跑验证

- 每次相关修改：`npm run test:protected-image-profile-switch`
- 涉及真实供应商行为且用户明确授权付费时：
  `SHENSI_RUN_PAID_PROFILE_SWITCH_ACCEPTANCE=1 electron scripts/run-protected-image-profile-switch-acceptance.cjs`

真实验收脚本具有断点账本。已经通过尺寸和哈希回读的步骤只能复用，不得重复扣费；已有厂商任务号时必须继续轮询/下载，不能盲目重新提交。失败时不得跳过当前配置。

## 不可变约束

- 固定首步是 `image-cockpit-aggregate-api`，固定末步是 `default`。
- `duanju-zuiqianxian` 永远不能进入本验收序列。
- 即梦配置回执的 `profileId` 与实时 `userId` 必须同时匹配保存身份；报告不得记录真实 `userId`、凭证指纹或 API Key。
- 聚合 API 不得携带 `dreaminaCliProfile` 等即梦元数据。
- 普通状态读取、配置切换和生成前探针不得隐式执行 `login --headless`。
- OAuth 的 `checklogin` 成功证据必须先持久化；随后身份回读遇到凭证槽繁忙或短暂 `AUTH_REQUIRED` 时，在有界宽限期内必须保留新凭证和 pending，不得立即恢复旧凭证。
- `login --headless` 的官方语义是“会话无效时启动新的 Device Flow”，不是保存会话恢复。OAuth 收尾、身份读取、图片和视频桥接均不得用它恢复会话，避免覆盖刚由 `checklogin` 写入的有效令牌。
- 参与受保护序列的非默认即梦配置必须拥有经过哈希验证的兼容独立 CLI；不得因为独立文件缺失而静默回退到行为不同的共享构建。发现缺失时应阻止需要重新授权的操作并先报备修复范围。
- 生成过程必须使用普通串行循环与 `await`；禁止并发提交跨账号任务。
- 不得为验收修改现有供应商连接、模型、端点或凭证。
