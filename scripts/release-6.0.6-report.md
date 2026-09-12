# 神思 6.0.6 发布与覆盖安装记录

日期：2026-09-12。工作分支：`codex/semantic-routing-cleanup`。

## 交付

- 发布：https://github.com/wu798998264-crypto/shensi/releases/tag/v6.0.6
- 构建：`20260912093947584`；标签 `v6.0.6` 指向构建源码提交 `ea430a87cb8cffe682bc61ba889ab8293ef280ab`。
- 安装包：`release/windows/Shensi-Setup-6.0.6-20260912093947584-x64.exe`，240011808 字节。
- SHA-256：`af9fa486f76cb628ced03a3c9974db36a9c92078431ed19e455d8b40d7c2c936`，与 GitHub 资产 digest 一致。
- 覆盖位置：`C:/Users/Administrator/AppData/Local/Programs/Shensi`；NSIS 安装返回 0。
- 已打开正常窗口“神思 6.0.6”；本地核心返回 6.0.6，内置能力包验签通过。
- 安装版运行哈希：`1008210d8f43b8184d2490173e5b3481dc55a2f8a81590ee6989add833518d0d`。
- 已公开上传安装包、SHA256SUMS.txt、update-manifest.json，并设为 latest。实际安装版检查更新返回：currentVersion=6.0.6，latestVersion=6.0.6，securityReady=true，“当前已是最新版本”。从 GitHub 下载的更新清单已再次验签。

## 提交

| 提交 | 内容 | 验证 |
| --- | --- | --- |
| e50c9b3 | 根包、锁文件和桌面包版本改为 6.0.6 | 版本一致性测试、最终完整校验 |
| 62e79fc | 页面标题与主入口缓存标识更新 | 版本一致性、源码及安装版界面验收 |
| 2336372 | 写入测试显式提供 Agent 计划；配置模块缓存标识更新 | 写入测试、npm test、媒体回归 |
| ea430a8 | 界面测试改用当前运行器入口，验证旧模式控件移除；增加 NSIS 更新参数断言 | 主界面验收、发布工程测试、完整校验 |

此前功能提交 `89aa11e`、`c0fc5fd`、`bcf1863` 的旧运行路径/关键词路由清理，以及 `7f4f826`、`246ac64` 的媒体错误与终止修复，均包含在此次构建中。具体清理边界见 `scripts/semantic-routing-cleanup-report.md`。

发布机的 `update-config.json` 是既有 Git 忽略的本地发布配置，本轮仅将旧 Inno Setup 参数改为 NSIS 的 `/S`，未改变仓库、公钥或签名身份。该文件已随安装包交付；未向源码库提交本地私钥或证书。

## 验收与边界

- 完整 `npm run verify` 内全部步骤通过，包含 `npm test`、真实内置 Agent + 模拟上游的工具写入回读、Electron 界面、同步、桌面生命周期、数据审计和性能基准。
- `npm run test:media-lifecycle`：21/21；`npm run test:protected-image-profile-switch`：通过。
- 使用真实安装的 Shensi.exe、独立临时用户目录，再跑完整主界面验收：通过。测试数据未写入正式用户作品或正式供应商配置。
- 安装内容策略：812 个应用文件通过；三个新建初始状态均无开发者作品、测试内容、凭据或运行记录。
- 安装版 16 个媒体回归关联源码哈希全部匹配已验收源码。
- 通过 `--shensi-quit` 正常退出旧版，无强杀。安装前未发现进行中的媒体/Agent 任务。
- 覆盖前后记录的 89 个作品/笔记状态、配置、Agent 任务文件哈希全部一致。用户数据仍保留于 `E:/ShensiUserData`，没有删除或修改历史版本。
- 安装包最终签名第一次因短暂文件占用失败；未重新构建、未跳过验证。文件释放后单独重跑项目签名步骤成功，再通过安装包校验、可信时间戳校验和更新清单验签。
- 已清除可重建的 win-unpacked 暂存目录（约 880 MiB）；6.0.4、6.0.5 和 6.0.6 安装包均保留。
- 主工作区 `shensi-source` 的另外九个未提交文件未被覆盖或混入此次构建；只推送本分支和版本标签，没有修改远端 main。
- 未进行真实付费图片/视频生成。CLI 故障使用模拟响应；不代表第三方服务实时可用性已获付费验收。
- Authenticode 为现有神思自签名证书，本机验证有效并附 DigiCert 可信时间戳；不是商业 CA 颁发的 OV/EV 证书，其他电脑可能出现不受信任或 Smart App Control 提示。

## 回退

先正常退出神思，再运行本工作区保留的 `release/windows/Shensi-Setup-6.0.5-20260911110854789-x64.exe` 覆盖安装。不要删除 `E:/ShensiUserData`，不要卸载时清理用户数据。

源码回退应另建 worktree/分支查看 `c6093ae`（6.0.5 发布节点），或按需使用 `git revert` 撤销指定功能提交；不要强制重置当前工作区，不要覆盖其他任务修改。发布安装包与标签保持不可变。
