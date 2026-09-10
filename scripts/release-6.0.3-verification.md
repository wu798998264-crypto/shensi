# 神思 6.0.3 验收与发布记录

安装版本：6.0.3；构建：20260910035834569。
本地分支：codex/report-delivery-performance。
发布页：https://github.com/wu798998264-crypto/shensi/releases/tag/v6.0.3

## 修改与提交

| 提交 | 修改 | 验证 |
|---|---|---|
| 8f3686d | 报告语义归档复核；路由补充；事件增量存储；卡片合并；定向目标读取 | 事务、界面、HTTP、事件恢复测试通过 |
| 56a3e06 | 启用签名时间戳、发布验证编码参数 | 原生签名隔离测试通过 |
| 9950e0d | 升级6.0.3 | 构建身份测试通过 |
| 750a1a4、ff83ada | 同步旧离线签名断言 | 对应定向测试及完整verify通过 |
| e9f8080 | 当前文档仅作指代的测试契约 | 完成证据测试通过 |
| 55f6728、04f578d | 原生SDK最终签名、隔离PowerShell模块环境 | 最终EXE与更新清单验签通过 |

## 验证范围

- 完整 npm run verify 通过，包含源码、路由、白板、媒体、UI、同步、桌面生命周期、历史、发布工程、用户数据只读审计和工作区基准。
- 新增和定向测试通过：test-agent-event-journal、test-agent-delivery-reliability、test-conversation-agent-service、test-agent-permission-runtime、test-conversation-agent-http、test-conversation-agent-ui、test-native-workspace-structure-service、test-conversation-agent-structure-tools、test-github-update-foundation。
- 写入覆盖：新建正文和reports报告、覆盖正文和标题、追加、精确局部替换、重命名、重复提交幂等、旧revision拒绝、完整旧稿历史，以及结构工具复制、移动、删除和恢复。
- 界面验收覆盖：重复状态栏移除、读取清单归入任务卡片、最后一问继续交付、多对话、空对话刷新恢复、标题链接定位。
- 200条事件仅增量追加；未完成快照不随每条事件重写；断电尾部残片可恢复已完整事件。
- 受保护的跨配置串行生图合同测试通过，未消耗付费生图积分。

## 安装与发布

安装返回码0；安装版主窗口“神思6.0.3”响应正常。用户数据未删除、未迁移。
EXE大小239619184字节。
SHA-256：e4a17c216a00d5c3829384dd3d2fc608aa5d43d9bed6ec2d32d76c3edc09a33a。
安装包与主程序Authenticode在本机验证Valid；安装包有DigiCert可信时间戳。
GitHub发布文件仅包含EXE、SHA256SUMS.txt、update-manifest.json；远端摘要与本地一致，远端清单公钥验签通过。未上传本地源码历史、用户作品、测试作品或凭据。
6.0.3安装版更新接口返回“当前已是最新版本”；6.0.2身份调用同一更新模块返回发现6.0.3、installReady=true。

## 限制与回退

事务和故障回归采用隔离工作区及模拟模型；没有对真实用户正文执行测试写入，也没有验证所有在线模型在任意任务下的语义判断。对话交付增加一次语义复核，可能增加一轮模型耗时与费用。性能改动降低已确认的重复渲染和磁盘开销，不保证任何硬件、网络或外部工具都不会卡顿。
发布者证书为本机信任证书，其他电脑的证书信任及SmartScreen提示仍取决于本机信任与发布者信誉。
源码回退基点为b74cac9：可在独立worktree检出该提交进行比较，或在修复分支按逆序git revert对应提交；不要强制reset。旧6.0.2安装包曾有HashMismatch，不能直接作为可信回退包，必须重新构建并验签。作品内容继续使用神思历史版本恢复，与Git回退分离。
