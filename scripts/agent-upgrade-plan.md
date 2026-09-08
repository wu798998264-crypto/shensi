# 对话 Agent 执行链升级记录

状态：实施中。用户已授权执行整体方案；受保护媒体路由尚需独立授权。

## 不变边界

- 白板规则与配置设置模块不重构；现有媒体供应商、模型、端点、凭证不改。
- 覆盖、续写、追加、局部替换按既有操作语义、目标与合并规则执行。
- 每次正式文档修改前完整保存历史版本；保留查看、对比、恢复。
- 作品隔离、结构化板块、索引和固定信息格式保留。
- 经验板块和记忆检查板块的数据、功能、检查能力保留。
- 保留分支、补充、队列；不使用子 Agent。

## 工作项与验证

- [ ] 文字配置：默认限免agent配置（神思运行器 + 当前内置模型）；显示名限免模型；DeepSeek Agent 去重，删除独立旧神思运行器配置。保留配置恢复记录，验证引用和幂等归一化；不接触媒体配置。
- [ ] 完整历史：空白与非空文档都形成完整前镜像；磁盘历史成功后才写正文；失败不覆盖；验证既有四种写入行为和恢复。
- [ ] Agent 主导的对话链：原始指令、任务路由、按需文档/Skill、工具执行、会话持续性。移除旧 Chat 回退，不影响白板调用。
- [ ] 智能选择：结构化问题、选项、自由输入；先持久化用户消息和问题文字再展示选项；分支/任务隔离。
- [ ] 内置运行时：验证 Codex 内核与当前限免模型兼容性；安装包内置、独立目录、故障恢复；不擅自换模型或凭证。
- [ ] 媒体（独立授权后）：对话默认配置第一项、图片2K/高清、视频720p、缺时长才问；生成结果下载验收后自动备份全部资产，失败只重试备份。
- [ ] 外置运行器完整接管；分支、补充、队列、取消、断线恢复回归。
- [ ] 清除已被新通道替代的旧执行分支，定向测试与界面验收。

## 受保护媒体审批

可能影响聚合 API 生图路由、配置选择、提交/轮询/下载与幂等恢复的修改必须提前单独请示。改动回退不能撤销已提交的厂商任务。获准后至少运行 `npm run test:protected-image-profile-switch`；真实付费回归另行授权，排除短剧最前线。未获批准时不得启用绕过旧媒体路由的新入口。

## 修改与结果

本目录没有 Git 元数据。编辑前将被修改文件复制到本次独立备份目录；不覆盖原备份，不读写用户凭证。完成的测试与未完成部分在此逐项记录，未通过的工作不标记完成。

### 第一批：源码已实现，尚未发布

- 文字配置归一化：保留并默认提供 `text-public-agent`（限免agent配置），供应商显示“限免模型”；用户已选配置不被抢占。内置模型、实际提供商 ID 保持原值。
- DeepSeek CLI Agent 去重覆盖 OpenCode 与 Claude Code，优先当前选择；统一名称，旧配置引用通过文字专用别名修复。独立旧神思运行器条目移除；原配置元信息留存，已有本地凭证不删除。并未直接操作用户正在运行的配置库。
- 空白和非空正文的完整前镜像；在工作区锁内保存隔离历史并重新读取验证后，才开始写正文。历史失败则不写，旧前端状态不能抹掉新历史；恢复旧版本也会保存当前版本。白板不进入新增前镜像机制。
- 尚未实现/启用：Agent 主导的新对话入口、Codex 内核打包、外置全权接管、智能选项、媒体新默认值和全部资产自动备份、旧执行链删除。需要受保护媒体独立授权后继续接管共享入口，不能将第一批等同于整体完成。

原文件备份：`.agent-upgrade-backups/2026-09-08-agent-only/`。

定向测试 17/17 通过（测试使用临时目录/模拟服务，无真实付费生成）：

1. `test-agent-upgrade-profiles.mjs`
2. `test-agent-upgrade-history.mjs`
3. `test-text-profile-cleanup.mjs`
4. `test-agent-profile-isolation-v2.mjs`
5. `test-generation-config-no-rewrite.mjs`
6. `test-text-runtime-binding-cleanup.mjs`
7. `test-free-agent-runtime.mjs`
8. `test-public-model-provider.mjs`
9. `test-public-text-capability-evidence.mjs`
10. `test-v282-safe-write-transaction.mjs`
11. `test-v282-history-integrity.mjs`
12. `test-v120-native-document-transactions.mjs`
13. `test-v500-notebook-transaction-default.mjs`
14. `test-v124-batch-landing-acceptance.mjs`
15. `test-v124-whiteboard-storage.mjs`
16. `test-whiteboard-agent-runtime-picker.mjs`
17. `test-v219-runtime-memory-documents.mjs`

8 个改动源码模块通过 `node --check`。未运行全量 `npm test`，未进行安装包构建或真实界面验收。旧“默认 text-default / 移除全部免费配置”的测试断言已根据用户最新要求更新，其余保留能力断言未削弱。
