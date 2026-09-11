# 对话 Agent 执行链升级记录

状态：Agent 运行时重构阶段已完成并提交；尚未打包或覆盖安装。受保护媒体底层流程未改动。

## 不变边界

- 白板规则与配置设置模块不重构；现有媒体供应商、模型、端点、凭证不改。
- 覆盖、续写、追加、局部替换按既有操作语义、目标与合并规则执行。
- 每次正式文档修改前完整保存历史版本；保留查看、对比、恢复。
- 作品隔离、结构化板块、索引和固定信息格式保留。
- 经验板块和记忆检查板块的数据、功能、检查能力保留。
- 保留分支、补充、队列和多对话并行；手动操作入口继续可用。

## 工作项与验证

- [x] 文字配置：默认免费模型（内置 Agent + 当前内置模型）；DeepSeek Agent 去重，删除退役的独立内置运行器配置。保留配置恢复记录，验证引用和幂等归一化；不接触媒体配置。
- [x] 完整历史：空白与非空文档都形成完整前镜像；磁盘历史成功后才写正文；失败不覆盖；验证既有四种写入行为和恢复。
- [x] Agent 主导的对话链：原始指令、任务路由、按需文档/Skill、工具执行、会话持续性。普通对话统一进入 Agent，旧 Chat 回退已移除，不影响白板调用。
- [x] 智能选择：结构化问题、动态选项、自由输入；问题先进入对话记录后展示选项；分支/任务隔离。普通编号步骤和细则不转换为选择框。
- [x] Agent 工作区管理：读取、历史、写入、文件夹/文档移动、复制、重命名、删除（回收站）和恢复均提供 Agent 工具；手动 UI 操作保留。白板仍由原通道处理。
- [x] 可信文档回执：完整磁盘验收后在对话中显示与文档标题一致的可点击链接，可跳回对应工作区文档。
- [x] 内置运行时：Codex 内核与当前免费模型兼容；运行时内置、目录隔离、故障恢复，不擅自换模型或凭证。
- [x] 媒体 Agent 接入：沿用既有受保护生成链；默认当前配置第一项、图片2K/高清、视频720p、缺时长才问；下载验收后备份全部资产，失败只重试备份。仅运行模拟回归，未产生付费任务。
- [x] 外置运行器完整接管；分支、补充、队列、取消、断线恢复回归。
- [x] 清除已被新通道替代的旧执行分支，完成定向测试与真实界面验收。

## 受保护媒体审批

可能影响聚合 API 生图路由、配置选择、提交/轮询/下载与幂等恢复的修改必须提前单独请示。改动回退不能撤销已提交的厂商任务。获准后至少运行 `npm run test:protected-image-profile-switch`；真实付费回归另行授权，排除短剧最前线。未获批准时不得启用绕过旧媒体路由的新入口。

## 修改与结果

源码已在独立分支 `refactor/agent-runtime` 使用本地 Git 管理；基线标签为 `baseline-before-agent-runtime-refactor`。本记录不包含凭证、用户作品、缓存、日志、依赖或打包产物。完成的测试与未完成部分在此逐项记录，未通过的工作不标记完成。

### 当前阶段：源码已实现，尚未发布

- 文字配置归一化：保留并默认提供 `text-public-agent`（显示名“免费模型”）；用户已选配置不被抢占。内置模型、实际提供商 ID 保持原值。
- DeepSeek CLI Agent 去重覆盖 OpenCode 与 Claude Code，优先当前选择；统一名称，旧配置引用通过文字专用别名修复。退役的独立内置运行器条目移除；原配置元信息留存，已有本地凭证不删除。并未直接操作用户正在运行的配置库。
- 空白和非空正文的完整前镜像；在工作区锁内保存隔离历史并重新读取验证后，才开始写正文。历史失败则不写，旧前端状态不能抹掉新历史；恢复旧版本也会保存当前版本。白板不进入新增前镜像机制。
- 本阶段未打包、未覆盖安装。媒体供应商、账号隔离、下载验收和跨配置串行生图流程保持原样；媒体默认值和资产归档仅按既有受保护链路验证，不在本阶段扩展。

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

本阶段定向回归通过：结构事务、结构工具、完整历史写入、双会话并行、HTTP Agent、动态选择流程、Agent UI 决策、统一 Agent 模式、运行边界、工作区隔离、文档跳转和打包内容白名单。未运行全量 `npm test`，未进行安装包构建或覆盖安装；真实付费媒体回归未运行。另一个窗口的爆款扫榜与浏览器改动不属于本阶段提交。

## 最终收尾验收（2026-09-11）

工作树：`C:\Users\Administrator\Documents\神思\shensi-agent-finalization`

分支：`codex/agent-finalization`

基线：`baseline-before-agent-runtime-refactor`（`04a5908`）

本次收尾提交：

1. `f656478`：统一 Agent 的语义决策成为唯一权威，旧关键词结果不能覆盖 Agent 判断。
2. `4f67132`：执行语义、上下文、Skill 路由和写入授权统一由 Agent 合同驱动；保留白板独立通道。
3. `23b0818`：完成“免费模型”命名、退役运行器迁移清理、媒体手动终止与迟到结果抑制。
4. `f0738fd`：修复 Codex/OpenCode/Claude Code 的 npm 安装策略，并公开 Trae Work、WorkBuddy、自定义运行器的真实状态。
5. `cc7fcfa`：将文档、历史、选择框、创作引导、回收站和工作区确认测试同步到统一 Agent 合同。
6. `f58df1f`：移除测试中对关键词媒体向导的旧假设，新增 Agent 动态缺项选择、单次取消和禁止重复提交验收。

最终结果：

- `npm run build` 通过。
- `npm test`（含 pretest）通过。
- `npm run test:package-content-policy` 通过：模拟安装包仅包含 201 个运行文件，不含个人作品、测试工作区、原始资料或 reference-only 文件。
- 真实桌面 Agent 选择框、三档权限、双对话并行和文档链接跳转通过；截图位于 `artifacts/conversation-agent-native.png` 与 `artifacts/agent-permission-levels.png`。
- 媒体仅运行模拟回归：用户停止后只取消原持久任务，不重复提交；停止意图与结果抑制可跨重启恢复。未消耗真实供应商积分。
- 白板规则、白板配置、媒体供应商配置、模型、端点、凭证和受保护跨配置串行生图流程未修改。

回退方式：先切到目标提交检查，再用 `git revert <提交号>` 生成可审计的反向提交；不得使用强制重置。若需整体回到大改前状态，从标签 `baseline-before-agent-runtime-refactor` 新建分支或 worktree，不覆盖当前分支和用户修改。
